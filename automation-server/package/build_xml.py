#!/usr/bin/env python3
"""
build_xml.py
編集プラン(JSON)から、Premiere Pro に読み込める Final Cut Pro 7 XML (xmeml version 5) を作る。

使い方:
  python3 build_xml.py --plan plan.json --out premiere_timeline.xml

plan.json の形(時間はすべてシーケンスのフレーム数、整数):
{
  "sequence": {"name": "03_CUTS_POINT_TEXT_EDITABLE", "width": 1920, "height": 1080,
               "timebase": 25, "ntsc": false},
  "source": {"path": "/abs/source.mp4", "duration": 24565, "width": 640, "height": 360,
             "timebase": 25, "ntsc": false, "channels": 2, "samplerate": 48000},
  "cuts":   [{"start": 0, "end": 125, "in": 0, "out": 125}, ...],     # V1/A1(同じ値を使う)
  "telops": [{"track": 2, "text": "1行目\\r2行目", "start": 10, "end": 60}, ...],  # track 2=通常 3=強調
  "title":  {"text": "動画タイトル｜チャンネル名"},
  "bgm":    {"path": "/abs/bgm_main.mp3", "duration": 4000, "in": 0, "out": ...},
  "sfx":    [{"path": "/abs/sfx_01.mp3", "duration": 40, "start": 100}, ...],
  "style":  {...}   # 省略時は既定のテロップスタイル
}
"""

import argparse
import json
import os
import sys
import urllib.parse
from xml.sax.saxutils import escape


def pathurl(p):
    """Mac/Unixの絶対パス → file://localhost/... (日本語・スペース・#・% をURLエンコード)"""
    p = os.path.abspath(p)
    if os.name == "nt" or (len(p) > 1 and p[1] == ":"):
        p = "/" + p.replace("\\", "/")
    return "file://localhost" + urllib.parse.quote(p, safe="/")


def rate_xml(timebase, ntsc, indent):
    return (f"{indent}<rate>\n{indent}  <timebase>{timebase}</timebase>\n"
            f"{indent}  <ntsc>{'TRUE' if ntsc else 'FALSE'}</ntsc>\n{indent}</rate>\n")


def text_value(s):
    """改行(CR)は数値文字参照で書く。XMLパーサがCRをLFに正規化して消さないようにするため。"""
    return escape(s).replace("\r", "&#13;").replace("\n", "&#13;")


DEFAULT_STYLE = {
    # ユーザー提供の仕様(1920×1080用の補正値)。フォントが無い環境ではplan側で差し替える。
    "font": "砧 丸丸ゴシックBSr StdN",
    "fontsize": "31.0126582278",
    "alignment": "center",
    "horiz": "-0.0036458333",
    "vert": "0.4259259259",
    "scale": "100",
    "fontcolor": [255, 255, 255, 255],          # ARGB
    "emphasis_fontcolor": [255, 255, 212, 59],
    "backgroundcolor": [179, 63, 63, 63],
    "backgroundopacity": "70",
    "backgroundwidth": "20",
    # 右上タイトル
    "title_fontsize": "18",
    "title_alignment": "right",
    "title_horiz": "0.47",
    "title_vert": "-0.44",
}


def color_xml(pid, name, argb, ind):
    a, r, g, b = argb
    return (f"{ind}<parameter>\n{ind}  <parameterid>{pid}</parameterid>\n{ind}  <name>{name}</name>\n"
            f"{ind}  <value>\n{ind}    <alpha>{a}</alpha>\n{ind}    <red>{r}</red>\n"
            f"{ind}    <green>{g}</green>\n{ind}    <blue>{b}</blue>\n{ind}  </value>\n{ind}</parameter>\n")


def simple_param(pid, name, value, ind):
    return (f"{ind}<parameter>\n{ind}  <parameterid>{pid}</parameterid>\n{ind}  <name>{name}</name>\n"
            f"{ind}  <value>{value}</value>\n{ind}</parameter>\n")


def point_param(pid, name, h, v, ind):
    return (f"{ind}<parameter>\n{ind}  <parameterid>{pid}</parameterid>\n{ind}  <name>{name}</name>\n"
            f"{ind}  <value>\n{ind}    <horiz>{h}</horiz>\n{ind}    <vert>{v}</vert>\n{ind}  </value>\n"
            f"{ind}</parameter>\n")


def generator_xml(gid, text, start, end, seq, style, kind, ind):
    """kind: normal / emphasis / title"""
    tb, ntsc = seq["timebase"], seq["ntsc"]
    dur = end - start
    p = ind + "      "
    if kind == "title":
        font_size, align = style["title_fontsize"], style["title_alignment"]
        horiz, vert = style["title_horiz"], style["title_vert"]
        color = style["fontcolor"]
        if align == "right":
            # Premiereは読み込み時に alignment を無視し、horiz/vert を「文字の中心」として配置する
            # (実機で確認済み)。右寄せに見せるため、文字幅を見積もって中心位置を計算する。
            # XMLのfontsize×2.257 ≒ Premiere上のpx(全角1文字の幅)。
            px = float(font_size) * 2.257
            width = sum(1.0 if ord(ch) > 0xFF else 0.55 for ch in text) * px
            margin = seq["width"] * 0.025
            horiz = f"{(seq['width'] - margin - width / 2) / seq['width'] - 0.5:.10f}"
    else:
        font_size, align = style["fontsize"], style["alignment"]
        horiz, vert = style["horiz"], style["vert"]
        color = style["emphasis_fontcolor"] if kind == "emphasis" else style["fontcolor"]
    out = [f"{ind}<generatoritem id=\"{gid}\">\n",
           f"{ind}  <name>{escape(text.replace(chr(13), ' '))}</name>\n",
           f"{ind}  <duration>{dur}</duration>\n",
           rate_xml(tb, ntsc, ind + "  "),
           f"{ind}  <start>{start}</start>\n{ind}  <end>{end}</end>\n",
           f"{ind}  <in>0</in>\n{ind}  <out>{dur}</out>\n",
           f"{ind}  <enabled>TRUE</enabled>\n{ind}  <anamorphic>FALSE</anamorphic>\n",
           f"{ind}  <alphatype>black</alphatype>\n",
           f"{ind}  <effect>\n",
           f"{ind}    <name>Text</name>\n{ind}    <effectid>Text</effectid>\n",
           f"{ind}    <effectcategory>Text</effectcategory>\n{ind}    <effecttype>generator</effecttype>\n",
           f"{ind}    <mediatype>video</mediatype>\n"]
    pi = ind + "    "
    out.append(f"{pi}<parameter>\n{pi}  <parameterid>str</parameterid>\n{pi}  <name>Text</name>\n"
               f"{pi}  <value>{text_value(text)}</value>\n{pi}</parameter>\n")
    out.append(simple_param("font", "Font", escape(style["font"]), pi))
    out.append(simple_param("fontsize", "Size", font_size, pi))
    out.append(simple_param("alignment", "Alignment", align, pi))
    out.append(simple_param("horiz", "Horizontal", horiz, pi))
    out.append(simple_param("vert", "Vertical", vert, pi))
    out.append(color_xml("fontcolor", "Font Color", color, pi))
    if kind != "title":
        out.append(color_xml("backgroundcolor", "Background Color", style["backgroundcolor"], pi))
        out.append(simple_param("backgroundopacity", "Background Opacity", style["backgroundopacity"], pi))
        out.append(simple_param("backgroundwidth", "Background Width", style["backgroundwidth"], pi))
    out.append(point_param("center", "Center", horiz, vert, pi))
    out.append(point_param("anchorpoint", "Anchor Point", 0, 0, pi))
    out.append(simple_param("scale", "Scale", style["scale"], pi))
    out.append(f"{ind}  </effect>\n{ind}</generatoritem>\n")
    return "".join(out)


def file_full_xml(fid, path, info, ind, has_video):
    tb, ntsc = info["timebase"], info["ntsc"]
    s = [f"{ind}<file id=\"{fid}\">\n",
         f"{ind}  <name>{escape(os.path.basename(path))}</name>\n",
         f"{ind}  <pathurl>{pathurl(path)}</pathurl>\n",
         rate_xml(tb, ntsc, ind + "  "),
         f"{ind}  <duration>{info['duration']}</duration>\n",
         f"{ind}  <timecode>\n", rate_xml(tb, ntsc, ind + "    "),
         f"{ind}    <string>00:00:00:00</string>\n{ind}    <frame>0</frame>\n",
         f"{ind}    <displayformat>NDF</displayformat>\n{ind}  </timecode>\n",
         f"{ind}  <media>\n"]
    if has_video:
        s.append(f"{ind}    <video>\n{ind}      <samplecharacteristics>\n"
                 + rate_xml(tb, ntsc, ind + "        ")
                 + f"{ind}        <width>{info['width']}</width>\n{ind}        <height>{info['height']}</height>\n"
                 f"{ind}        <anamorphic>FALSE</anamorphic>\n{ind}        <pixelaspectratio>square</pixelaspectratio>\n"
                 f"{ind}        <fielddominance>none</fielddominance>\n"
                 f"{ind}      </samplecharacteristics>\n{ind}    </video>\n")
    s.append(f"{ind}    <audio>\n{ind}      <samplecharacteristics>\n"
             f"{ind}        <depth>16</depth>\n{ind}        <samplerate>{info.get('samplerate', 48000)}</samplerate>\n"
             f"{ind}      </samplecharacteristics>\n{ind}      <channelcount>{info.get('channels', 2)}</channelcount>\n"
             f"{ind}    </audio>\n")
    s.append(f"{ind}  </media>\n{ind}</file>\n")
    return "".join(s)


def motion_filter_xml(scale, ind):
    return (f"{ind}<filter>\n{ind}  <effect>\n{ind}    <name>Basic Motion</name>\n"
            f"{ind}    <effectid>basic</effectid>\n{ind}    <effectcategory>motion</effectcategory>\n"
            f"{ind}    <effecttype>motion</effecttype>\n{ind}    <mediatype>video</mediatype>\n"
            f"{ind}    <parameter>\n{ind}      <parameterid>scale</parameterid>\n{ind}      <name>Scale</name>\n"
            f"{ind}      <valuemin>0</valuemin>\n{ind}      <valuemax>1000</valuemax>\n"
            f"{ind}      <value>{scale}</value>\n{ind}    </parameter>\n"
            f"{ind}  </effect>\n{ind}</filter>\n")


def link_xml(ref, mediatype, trackindex, clipindex, ind):
    return (f"{ind}<link>\n{ind}  <linkclipref>{ref}</linkclipref>\n{ind}  <mediatype>{mediatype}</mediatype>\n"
            f"{ind}  <trackindex>{trackindex}</trackindex>\n{ind}  <clipindex>{clipindex}</clipindex>\n"
            f"{ind}  <groupindex>1</groupindex>\n{ind}</link>\n")


def build(plan):
    seq = plan["sequence"]
    src = plan["source"]
    style = dict(DEFAULT_STYLE)
    style.update(plan.get("style") or {})
    tb, ntsc = seq["timebase"], seq["ntsc"]
    cuts = plan["cuts"]
    telops = sorted(plan.get("telops", []), key=lambda t: t["start"])
    seq_dur = cuts[-1]["end"] if cuts else 0

    I = "        "  # track内のクリップのインデント
    # ── V1
    v1 = []
    scale = None
    if src.get("width") and (src["width"] != seq["width"] or src["height"] != seq["height"]):
        scale = round(100.0 * min(seq["width"] / src["width"], seq["height"] / src["height"]), 4)
    for i, c in enumerate(cuts, start=1):
        x = [f"{I}<clipitem id=\"clipitem-v1-{i}\">\n",
             f"{I}  <masterclipid>masterclip-1</masterclipid>\n",
             f"{I}  <name>{escape(src.get('orig') or os.path.basename(src['path']))}</name>\n",
             f"{I}  <enabled>TRUE</enabled>\n",
             f"{I}  <duration>{src['duration']}</duration>\n",
             rate_xml(tb, ntsc, I + "  "),
             f"{I}  <start>{c['start']}</start>\n{I}  <end>{c['end']}</end>\n",
             f"{I}  <in>{c['in']}</in>\n{I}  <out>{c['out']}</out>\n",
             f"{I}  <alphatype>none</alphatype>\n"]
        x.append(f"{I}  <file id=\"file-1\"/>\n")  # 完全な定義はビン(動画素材)の中に書く
        x.append(f"{I}  <sourcetrack>\n{I}    <mediatype>video</mediatype>\n{I}    <trackindex>1</trackindex>\n{I}  </sourcetrack>\n")
        if scale:
            x.append(motion_filter_xml(scale, I + "  "))
        x.append(link_xml(f"clipitem-v1-{i}", "video", 1, i, I + "  "))
        x.append(link_xml(f"clipitem-a1-{i}", "audio", 1, i, I + "  "))
        x.append(f"{I}</clipitem>\n")
        v1.append("".join(x))

    # ── A1
    a1 = []
    for i, c in enumerate(cuts, start=1):
        x = [f"{I}<clipitem id=\"clipitem-a1-{i}\">\n",
             f"{I}  <masterclipid>masterclip-1</masterclipid>\n",
             f"{I}  <name>{escape(src.get('orig') or os.path.basename(src['path']))}</name>\n",
             f"{I}  <enabled>TRUE</enabled>\n",
             f"{I}  <duration>{src['duration']}</duration>\n",
             rate_xml(tb, ntsc, I + "  "),
             f"{I}  <start>{c['start']}</start>\n{I}  <end>{c['end']}</end>\n",
             f"{I}  <in>{c['in']}</in>\n{I}  <out>{c['out']}</out>\n",
             f"{I}  <file id=\"file-1\"/>\n",
             f"{I}  <sourcetrack>\n{I}    <mediatype>audio</mediatype>\n{I}    <trackindex>1</trackindex>\n{I}  </sourcetrack>\n",
             link_xml(f"clipitem-v1-{i}", "video", 1, i, I + "  "),
             link_xml(f"clipitem-a1-{i}", "audio", 1, i, I + "  "),
             f"{I}</clipitem>\n"]
        a1.append("".join(x))

    # ── V2 / V3 テロップ、V4 タイトル
    v2, v3 = [], []
    for k, t in enumerate(telops, start=1):
        kind = "emphasis" if t.get("track") == 3 else "normal"
        g = generator_xml(f"generator-telop-{k}", t["text"], t["start"], t["end"], seq, style, kind, I)
        (v3 if kind == "emphasis" else v2).append(g)
    v4 = []
    if plan.get("title"):
        v4.append(generator_xml("generator-title-1", plan["title"]["text"], 0, seq_dur, seq, style, "title", I))

    # ── A2 BGM / A3 SFX
    def levels_filter(gain, ind, fade_in=0, fade_out=0, length=0, points=None):
        """Audio Levels(リニアゲイン。1.0=0dB)。fade_in/fade_outはクリップ内のフレーム数。
        points を渡した場合はそれをそのままキーフレーム(クリップ内フレーム, ゲイン)にする。
        Premiere 2026 で読み込み、Volume>Level とキーフレームに反映されることを実機確認済み。"""
        kf = ""
        pts = list(points or [])
        if not pts and (fade_in or fade_out):
            if fade_in:
                pts += [(0, 0.0), (fade_in, gain)]
            if fade_out:
                pts += [(max(0, length - fade_out), gain), (length, 0.0)]
        if pts:
            kf = "".join(f"{ind}      <keyframe>\n{ind}        <when>{w}</when>\n{ind}        <value>{v:.6f}</value>\n{ind}      </keyframe>\n" for w, v in pts)
        return (f"{ind}<filter>\n{ind}  <effect>\n{ind}    <name>Audio Levels</name>\n"
                f"{ind}    <effectid>audiolevels</effectid>\n{ind}    <effectcategory>audiolevels</effectcategory>\n"
                f"{ind}    <effecttype>audiolevels</effecttype>\n{ind}    <mediatype>audio</mediatype>\n"
                f"{ind}    <parameter>\n{ind}      <parameterid>level</parameterid>\n{ind}      <name>Level</name>\n"
                f"{ind}      <valuemin>0</valuemin>\n{ind}      <valuemax>3.98109</valuemax>\n"
                f"{ind}      <value>{gain:.6f}</value>\n{kf}{ind}    </parameter>\n"
                f"{ind}  </effect>\n{ind}</filter>\n")

    def audio_clip(cid, fid, path, info, start, end, inp, ind, full, gain=None, fade_in=0, fade_out=0, points=None):
        full = False  # 完全な定義はビン(BGM/効果音)の中に書く
        x = [f"{ind}<clipitem id=\"{cid}\">\n",
             f"{ind}  <masterclipid>master-{fid}</masterclipid>\n",
             f"{ind}  <name>{escape(info.get('orig') or os.path.basename(path))}</name>\n",
             f"{ind}  <enabled>TRUE</enabled>\n",
             f"{ind}  <duration>{info['duration']}</duration>\n",
             rate_xml(tb, ntsc, ind + "  "),
             f"{ind}  <start>{start}</start>\n{ind}  <end>{end}</end>\n",
             f"{ind}  <in>{inp}</in>\n{ind}  <out>{inp + (end - start)}</out>\n"]
        if full:
            finfo = dict(info, timebase=tb, ntsc=ntsc)
            x.append(file_full_xml(fid, path, finfo, ind + "  ", False))
        else:
            x.append(f"{ind}  <file id=\"{fid}\"/>\n")
        x.append(f"{ind}  <sourcetrack>\n{ind}    <mediatype>audio</mediatype>\n{ind}    <trackindex>1</trackindex>\n{ind}  </sourcetrack>\n")
        if gain is not None:
            x.append(levels_filter(gain, ind + "  ", fade_in, fade_out, end - start, points))
        x.append(f"{ind}</clipitem>\n")
        return "".join(x)

    a2 = []
    bgm = plan.get("bgm")
    if bgm:
        # BGMが動画より短い場合はループして全編を埋める
        pos, n = 0, 0
        g = bgm.get("gain")
        fi, fo = bgm.get("fade_in", 0), bgm.get("fade_out", 0)
        env = sorted(bgm.get("envelope") or [])  # [(シーケンスのフレーム, ゲイン)] ダッキング用

        def env_at(f):
            if not env:
                return g
            if f <= env[0][0]:
                return env[0][1]
            for (f0, v0), (f1, v1) in zip(env, env[1:]):
                if f0 <= f <= f1:
                    return v0 if f1 == f0 else v0 + (v1 - v0) * (f - f0) / (f1 - f0)
            return env[-1][1]

        while pos < seq_dur:
            n += 1
            length = min(bgm["duration"], seq_dur - pos)
            last = pos + length >= seq_dur
            points = None
            if env or fi or fo:
                pts = {0: env_at(pos), length: env_at(pos + length)}
                for f, v in env:
                    if pos < f < pos + length:
                        pts[f - pos] = v
                if n == 1 and fi:
                    pts = {k: v for k, v in pts.items() if k > fi}
                    pts[0], pts[fi] = 0.0, env_at(pos + fi)
                if last and fo:
                    pts = {k: v for k, v in pts.items() if k < length - fo}
                    pts[length - fo], pts[length] = env_at(pos + length - fo), 0.0
                points = sorted(pts.items())
            a2.append(audio_clip(f"clipitem-bgm-{n}", "file-bgm", bgm["path"], bgm, pos, pos + length, 0, I, n == 1,
                                 gain=g, points=points))
            pos += length
    a3 = []
    seen = {}
    for k, s in enumerate(plan.get("sfx", []), start=1):
        fid = seen.get(s["path"])
        full = fid is None
        if full:
            fid = f"file-sfx-{len(seen) + 1}"
            seen[s["path"]] = fid
        end = min(s["start"] + s["duration"], seq_dur)
        a3.append(audio_clip(f"clipitem-sfx-{k}", fid, s["path"], s, s["start"], end, 0, I, full, gain=s.get("gain")))

    def track(items, extra=""):
        return f"      <track>\n{''.join(items)}{extra}        <enabled>TRUE</enabled>\n        <locked>FALSE</locked>\n      </track>\n"

    def atrack(items):
        return (f"      <track>\n{''.join(items)}        <enabled>TRUE</enabled>\n        <locked>FALSE</locked>\n"
                f"        <outputchannelindex>1</outputchannelindex>\n      </track>\n")

    # ── ビン(Premiereのプロジェクトパネルのフォルダ)。素材の完全な定義はここに書き、シーケンスからは参照だけする。
    # 読み込むと「動画素材」「BGM」「効果音」のビンができ、元のファイル名で並ぶ(Premiere 2026 で実機確認済み)
    def bin_clip(mid, fid, path, info, name, has_video, ind):
        dur = info["duration"]
        finfo = dict(info, timebase=info.get("timebase", tb), ntsc=info.get("ntsc", ntsc))
        head = (f"{ind}<clip id=\"{mid}\">\n{ind}  <name>{escape(name)}</name>\n{ind}  <duration>{dur}</duration>\n"
                + rate_xml(finfo["timebase"], finfo["ntsc"], ind + "  ") + f"{ind}  <media>\n")
        body = ""
        kinds = (["video"] if has_video else []) + ["audio"]
        for n, kind in enumerate(kinds):
            fx = file_full_xml(fid, path, finfo, ind + "          ", has_video) if n == 0 else f"{ind}          <file id=\"{fid}\"/>\n"
            body += (f"{ind}    <{kind}>\n{ind}      <track>\n{ind}        <clipitem id=\"{mid}-{kind}\">\n"
                     f"{ind}          <name>{escape(name)}</name>\n{ind}          <duration>{dur}</duration>\n"
                     + rate_xml(finfo["timebase"], finfo["ntsc"], ind + "          ")
                     + f"{ind}          <start>0</start>\n{ind}          <end>{dur}</end>\n"
                     f"{ind}          <in>0</in>\n{ind}          <out>{dur}</out>\n" + fx
                     + f"{ind}          <sourcetrack>\n{ind}            <mediatype>{kind}</mediatype>\n"
                     f"{ind}            <trackindex>1</trackindex>\n{ind}          </sourcetrack>\n"
                     f"{ind}        </clipitem>\n{ind}      </track>\n{ind}    </{kind}>\n")
        return head + body + f"{ind}  </media>\n{ind}</clip>\n"

    def bin_xml(name, clips):
        return f"    <bin>\n      <name>{escape(name)}</name>\n      <children>\n{''.join(clips)}      </children>\n    </bin>\n"

    B = "        "
    bins = [bin_xml(plan.get("bin_names", {}).get("video", "動画素材"),
                    [bin_clip("masterclip-1", "file-1", src["path"], src,
                              src.get("orig") or os.path.basename(src["path"]), True, B)])]
    if bgm:
        bins.append(bin_xml(plan.get("bin_names", {}).get("bgm", "BGM"),
                            [bin_clip("master-file-bgm", "file-bgm", bgm["path"], bgm,
                                      bgm.get("orig") or os.path.basename(bgm["path"]), False, B)]))
    if seen:
        sfx_by_path = {s["path"]: s for s in plan.get("sfx", [])}
        bins.append(bin_xml(plan.get("bin_names", {}).get("sfx", "効果音"),
                            [bin_clip(f"master-{fid}", fid, p, sfx_by_path[p],
                                      sfx_by_path[p].get("orig") or os.path.basename(p), False, B)
                             for p, fid in seen.items()]))

    xml = ['<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n<xmeml version="5">\n',
           f'  <project>\n    <name>{escape(seq["name"])}</name>\n    <children>\n', *bins,
           f'  <sequence id="sequence-1">\n    <name>{escape(seq["name"])}</name>\n',
           f"    <duration>{seq_dur}</duration>\n", rate_xml(tb, ntsc, "    "),
           "    <timecode>\n", rate_xml(tb, ntsc, "      "),
           "      <string>00:00:00:00</string>\n      <frame>0</frame>\n      <displayformat>NDF</displayformat>\n    </timecode>\n",
           "    <media>\n      <video>\n        <format>\n          <samplecharacteristics>\n",
           rate_xml(tb, ntsc, "            "),
           f"            <width>{seq['width']}</width>\n            <height>{seq['height']}</height>\n",
           "            <anamorphic>FALSE</anamorphic>\n            <pixelaspectratio>square</pixelaspectratio>\n",
           "            <fielddominance>none</fielddominance>\n          </samplecharacteristics>\n        </format>\n",
           track(v1), track(v2), track(v3), track(v4), track([]),
           "      </video>\n      <audio>\n        <numOutputChannels>2</numOutputChannels>\n",
           "        <format>\n          <samplecharacteristics>\n            <depth>16</depth>\n",
           "            <samplerate>48000</samplerate>\n          </samplecharacteristics>\n        </format>\n",
           "        <outputs>\n          <group>\n            <index>1</index>\n            <numchannels>2</numchannels>\n",
           "            <downmix>0</downmix>\n            <channel>\n              <index>1</index>\n            </channel>\n",
           "            <channel>\n              <index>2</index>\n            </channel>\n          </group>\n        </outputs>\n",
           atrack(a1), atrack(a2), atrack(a3),
           "      </audio>\n    </media>\n  </sequence>\n    </children>\n  </project>\n</xmeml>\n"]
    # 完全なXMLの中では、ネストの都合でトラック内クリップのインデントは揃っていないが、
    # パース結果には影響しない
    return "".join(xml)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--plan", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    with open(a.plan, encoding="utf-8") as f:
        plan = json.load(f)
    xml = build(plan)
    with open(a.out, "w", encoding="utf-8", newline="\n") as f:  # BOMなし
        f.write(xml)
    print(f"XMLを書き出しました: {a.out}")


if __name__ == "__main__":
    sys.exit(main())
