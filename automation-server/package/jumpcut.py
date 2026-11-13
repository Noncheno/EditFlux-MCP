#!/usr/bin/env python3
"""
jumpcut.py
音声の平均音量(20ms単位のRMS)から無音を判定し、ジャンプカットで「残す区間」を求める。
EditFlux(automation-server/server.js の workflowJumpCut)でユーザーと調整済みのロジックを移植したもの。

- しきい値は素材ごとに自動(ノイズ10パーセンタイル〜声90パーセンタイルの60%位置、-50〜-25dB)
- 息継ぎは無音として扱い、カットする
- 喋り終わりの後に tail 秒残す(natural=1.0秒 / tempo=0.15秒)
- 次の言葉の始まりから直接つなぐ(喋り出し前の余白0)
- 喋り終わりから0.3秒以内に続く短い音は語尾として残す
- 言葉の直前0.1秒以内にある声の大きさの短い音は言葉の頭として残す
"""

import math
import subprocess
import sys

FRAME_SEC = 0.02
SR = 16000
NOISE_BLIP_SEC = 0.12
SOFT_ENDING_GAP_SEC = 0.3
ONSET_LEAD_GAP_SEC = 0.1
MIN_CUT_SEC = 0.2

PRESETS = {
    "natural": {"tail": 1.0, "breath": 0.0},   # 間を残す
    "tempo": {"tail": 0.15, "breath": 0.0},    # テンポ重視
}


def read_levels(media_path, ffmpeg="ffmpeg"):
    """音声を20ms単位のRMS(dB)列にする"""
    import numpy as np
    raw = subprocess.run(
        [ffmpeg, "-v", "error", "-i", media_path, "-vn", "-ac", "1", "-ar", str(SR), "-f", "s16le", "-"],
        stdout=subprocess.PIPE, check=True).stdout
    a = np.frombuffer(raw, dtype="<i2").astype(np.float64) / 32768.0
    frame = int(SR * FRAME_SEC)
    n = len(a) // frame
    ms = (a[: n * frame].reshape(n, frame) ** 2).mean(axis=1)
    return (10 * np.log10(ms + 1e-12)).tolist()


def adaptive_threshold(dbs):
    valid = sorted(d for d in dbs if d > -90)
    if len(valid) < 40:
        return {"threshold": -35.0, "noise": None, "speech": None}
    pct = lambda p: valid[min(len(valid) - 1, int(len(valid) * p))]
    noise, speech = pct(0.1), pct(0.9)
    thr = max(-50.0, min(-25.0, noise + (speech - noise) * 0.6))
    return {"threshold": round(thr, 1), "noise": round(noise, 1), "speech": round(speech, 1)}


def silences_from_levels(dbs, thr):
    out, start = [], -1
    for i in range(len(dbs) + 1):
        silent = i < len(dbs) and dbs[i] < thr
        if silent and start < 0:
            start = i
        if not silent and start >= 0:
            out.append([start * FRAME_SEC, i * FRAME_SEC])
            start = -1
    return out


def merge_nearby(iv, gap):
    if not iv:
        return []
    iv = sorted(iv)
    out = [list(iv[0])]
    for s, e in iv[1:]:
        if s - out[-1][1] <= gap:
            out[-1][1] = max(out[-1][1], e)
        else:
            out.append([s, e])
    return out


def extend_past_soft_endings(sil, dbs, thr):
    out = []
    for s, e in sil:
        last = s
        for i in range(round(s / FRAME_SEC), min(len(dbs), round(e / FRAME_SEC))):
            t = i * FRAME_SEC
            if t - last > SOFT_ENDING_GAP_SEC:
                break
            if dbs[i] >= thr:
                last = t + FRAME_SEC
        if last < e:
            out.append([last, e])
    return out


def extend_before_onsets(sil, dbs, loud):
    out = []
    for s, e in sil:
        first = e
        i0 = round(s / FRAME_SEC)
        for i in range(min(len(dbs), round(e / FRAME_SEC)) - 1, i0 - 1, -1):
            t = i * FRAME_SEC
            if first - (t + FRAME_SEC) > ONSET_LEAD_GAP_SEC:
                break
            if dbs[i] >= loud:
                first = t
        if first > s:
            out.append([s, first])
    return out


def keep_regions(dbs, duration_sec, mode="natural"):
    """残す区間 [[start,end],...] (素材の秒) と判定情報を返す"""
    p = PRESETS[mode]
    lv = adaptive_threshold(dbs)
    thr = lv["threshold"]
    sil = merge_nearby(silences_from_levels(dbs, thr), NOISE_BLIP_SEC)
    sil = extend_past_soft_endings(sil, dbs, thr)
    speech = lv["speech"] if lv["speech"] is not None else thr + 15
    sil = extend_before_onsets(sil, dbs, max(thr, speech - 12))
    min_dur = p["tail"] + p["breath"] + MIN_CUT_SEC
    cuts = []
    for s, e in sil:
        if e - s < min_dur:
            continue
        # 先頭の無音(喋り出し前)は語尾ではないので、tailを残さずに言葉の始まりまで切る
        cs = s if s <= 0.0 else s + p["tail"]
        ce = e - p["breath"] if e < duration_sec - 0.01 else duration_sec
        if ce - cs >= MIN_CUT_SEC:
            cuts.append([cs, ce])
    keep, t = [], 0.0
    for cs, ce in cuts:
        if cs > t:
            keep.append([t, cs])
        t = ce
    if t < duration_sec:
        keep.append([t, duration_sec])
    keep = [k for k in keep if k[1] - k[0] >= 0.04]
    return keep, lv


def quietest_near(dbs, t, window=0.15):
    """t付近(±window)で最も静かなフレームの時刻。言い間違いカットの境界を無音に寄せる"""
    i0 = max(0, round((t - window) / FRAME_SEC))
    i1 = min(len(dbs) - 1, round((t + window) / FRAME_SEC))
    if i1 <= i0:
        return t
    best = min(range(i0, i1 + 1), key=lambda i: dbs[i])
    return best * FRAME_SEC


def subtract(keep, removals):
    """keep区間からremovals区間を取り除く"""
    out = []
    for ks, ke in keep:
        segs = [[ks, ke]]
        for rs, re_ in removals:
            nxt = []
            for s, e in segs:
                if re_ <= s or rs >= e:
                    nxt.append([s, e])
                    continue
                if rs > s:
                    nxt.append([s, rs])
                if re_ < e:
                    nxt.append([re_, e])
            segs = nxt
        out.extend(segs)
    return [k for k in out if k[1] - k[0] >= 0.04]


class Timeline:
    """素材の時刻 ⇔ カット後タイムラインの時刻の変換"""

    def __init__(self, keep):
        self.keep = keep
        self.offsets = []
        acc = 0.0
        for s, e in keep:
            self.offsets.append(acc)
            acc += e - s
        self.duration = acc

    def to_timeline(self, t):
        """素材時刻 → タイムライン時刻。カットされた区間内なら None"""
        for (s, e), off in zip(self.keep, self.offsets):
            if s - 1e-6 <= t <= e + 1e-6:
                return off + (t - s)
        return None

    def to_source(self, tl):
        for (s, e), off in zip(self.keep, self.offsets):
            if off - 1e-6 <= tl <= off + (e - s) + 1e-6:
                return s + (tl - off)
        return None
