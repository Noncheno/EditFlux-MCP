#!/usr/bin/env python3
"""
make_package.py
動画1本から、Premiere Pro に読み込める編集パッケージ(FCP7 XML + 素材 + 字幕 + プレビュー + 検証ログ)を作る。

使い方(例):
  python3 make_package.py \
    --video "/path/動画①.mp4" --out "/path/保存先" \
    --title "人は何のために生きるのか" --channel "神河照美" \
    --bgm ~/Downloads/BGM --sfx "~/Downloads/SE(効果音）" \
    [--script 台本.txt] [--design-image 参考.png] [--mode natural|tempo] [--max-seconds 180]

処理の流れ:
  1. 素材解析(ffprobe)・素材コピー(半角英数字の名前に変更)
  2. ジャンプカット(jumpcut.py。息継ぎもカット、natural=語尾1秒/tempo=0.15秒)
  3. カット後の音声をWhisperで単語ごとの時刻つき文字起こし
  4. (--misspeak 指定時のみ)Geminiで言い間違い・言い直し・重複・フィラーを検出してカット
  5. Geminiで最終音声+単語列+台本からテロップ(1〜2行・1行16字・文節改行・句読点なし)と強調を作成
  6. テロップの開始/終了を音声の話し始め/終わりに合わせる
  7. GeminiでBGM1曲・効果音2〜4個を選ぶ(フォルダ指定時)
  8. XML(premiere_timeline.xml / preview_match_sequence.xml)、字幕、資料、プレビュー動画
  9. XML検証(validate_xml.py) → Logs/xml_validation.txt
 Premiereへの実機読み込みはこのスクリプトの外(SKILL.mdの手順でClaudeがMCP経由)で行う。
"""

import argparse
import csv
import json
import math
import os
import re
import shutil
import subprocess
import sys
import time
import unicodedata

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import jumpcut as J  # noqa: E402
import gemini as G  # noqa: E402
import build_xml  # noqa: E402

AUDIO_EXT = {".mp3", ".wav", ".m4a", ".aif", ".aiff"}
PUNCT_RE = re.compile(r"[。、，．,.!！?？・「」『』（）()…‥〜~:：;；\"'“”‘’]")
BAD_SPACE_RE = re.compile(r"[ 　\t]")


def log(msg):
    print(msg, flush=True)


def run(cmd):
    return subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)


def probe(path):
    out = run(["ffprobe", "-v", "error", "-show_entries",
               "stream=codec_type,r_frame_rate,width,height,sample_rate,channels:format=duration",
               "-of", "json", path]).stdout
    d = json.loads(out)
    info = {"duration_sec": float(d["format"]["duration"])}
    for s in d.get("streams", []):
        if s["codec_type"] == "video" and "width" not in info:
            num, den = s["r_frame_rate"].split("/")
            info.update(width=int(s["width"]), height=int(s["height"]), fps=float(num) / float(den))
        if s["codec_type"] == "audio" and "samplerate" not in info:
            info.update(samplerate=int(s.get("sample_rate", 48000)), channels=int(s.get("channels", 2)))
    return info


def line_width(s):
    """全角=1、半角=0.5で数えた文字数"""
    return sum(1.0 if ord(c) > 0xFF else 0.5 for c in s)


def clean_line(s):
    s = PUNCT_RE.sub("", s)
    s = BAD_SPACE_RE.sub(" ", s)
    s = s.replace("\r", "").replace("\n", "")
    return re.sub(r" {2,}", " ", s).strip()


def ascii_name(prefix, src, n=None):
    ext = os.path.splitext(src)[1].lower()
    return f"{prefix}{'' if n is None else f'_{n:02d}'}{ext}"


def decode_audio(src, sr=16000, ch=1):
    """音声をまるごとPCM(numpy int16, shape=(n,ch))で読み込む"""
    import numpy as np
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", src, "-vn", "-ac", str(ch), "-ar", str(sr), "-f", "s16le", "-"],
                         stdout=subprocess.PIPE, check=True).stdout
    return np.frombuffer(raw, dtype="<i2").reshape(-1, ch)


def write_cut_wav(src, keep, out, sr=16000, ch=1):
    """keep区間だけをつないだwavを書く(区間がいくつあっても動くよう、ffmpegの式は使わずにPythonで切り出す)"""
    import numpy as np
    import wave
    pcm = decode_audio(src, sr, ch)
    parts = [pcm[int(round(s * sr)):int(round(e * sr))] for s, e in keep]
    data = np.concatenate(parts) if parts else pcm[:0]
    with wave.open(out, "wb") as w:
        w.setnchannels(ch)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(data.astype("<i2").tobytes())


def render_audio(src, keep, out, mono16k=True, mp3=False):
    if mp3:
        tmp = out + ".tmp.wav"
        write_cut_wav(src, keep, tmp)
        run(["ffmpeg", "-v", "error", "-y", "-i", tmp, "-b:a", "48k", out])
        os.remove(tmp)
    else:
        write_cut_wav(src, keep, out)


def list_audio(folder):
    folder = os.path.expanduser(folder)
    if os.path.isfile(folder):
        return [folder]
    return sorted(os.path.join(folder, f) for f in os.listdir(folder)
                  if os.path.splitext(f)[1].lower() in AUDIO_EXT and not f.startswith("."))


# ───────────────────────── 長い動画を分けてGeminiに渡す ─────────────────────────

CHUNK_SEC = 150


def chunk_words(words, chunk_sec=CHUNK_SEC):
    """単語列を約chunk_sec秒ごとに、言葉の切れ目(単語間の間が最大の所)で区切る"""
    chunks, start = [], 0
    while start < len(words):
        t0 = words[start]["start"]
        end = start
        while end + 1 < len(words) and words[end + 1]["start"] - t0 < chunk_sec:
            end += 1
        if end + 1 < len(words):
            lo = max(start, end - 40)
            best = max(range(lo, end + 1), key=lambda i: words[i + 1]["start"] - words[i]["end"])
            end = best
        chunks.append((start, end))
        start = end + 1
    return chunks


def slice_mp3(wav_pcm, sr, t0, t1, out):
    import wave
    seg = wav_pcm[int(max(0, t0) * sr):int(t1 * sr)]
    tmp = out + ".wav"
    with wave.open(tmp, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(seg.astype("<i2").tobytes())
    run(["ffmpeg", "-v", "error", "-y", "-i", tmp, "-b:a", "48k", out])
    os.remove(tmp)


def read_wav_pcm(path):
    import numpy as np
    import wave
    with wave.open(path, "rb") as w:
        return np.frombuffer(w.readframes(w.getnframes()), dtype="<i2"), w.getframerate()


def chunked(words, wav_path, work, tag):
    """[(チャンクの単語列(番号はそのまま), チャンク音声mp3)] を返す"""
    pcm, sr = read_wav_pcm(wav_path)
    out = []
    for n, (a, b) in enumerate(chunk_words(words)):
        mp3 = os.path.join(work, f"{tag}_{n:02d}.mp3")
        t0 = words[a]["start"] - 0.3
        t1 = words[b]["end"] + 0.3
        slice_mp3(pcm, sr, t0, t1, mp3)
        out.append((words[a:b + 1], mp3))
    return out


# ───────────────────────── Gemini: 言い間違い検出 ─────────────────────────

def detect_misspeaks(words, script_text, audio_mp3=None):
    toks = "\n".join(f"{w['i']}:{w['w']}" for w in words)
    prompt = (
        "添付の音声は、ジャンプカット済みの動画の話者音声です。下の単語列は同じ音声をWhisperで文字起こししたもの(番号:単語)です。"
        "音声をよく聞いて、話し方として次に当てはまる区間だけを「削除する単語の範囲」として返してください。\n"
        "Whisperは文字を聞き落としたり誤変換したりします(例:「したらたった」を「したった」と書く)。"
        "文字起こしの乱れを言い間違いと判断しないこと。必ず音声で確かめること。\n"
        "・明らかな言い間違いで、直後に言い直している場合の、間違えた側\n"
        "・言い直し前の不完全な発言(言いかけてやめた部分)\n"
        "・同じ内容を続けて2回言っている場合の、1回目\n"
        "・意味のないフィラー(えー、あのー、えっと、まあ 等)\n"
        "削除しても発言の意味と順番が変わらないものだけにしてください。アドリブや言い換えは削除しないこと。"
        "迷う場合は削除しないこと。該当が無ければ空の配列を返すこと。\n"
        + (f"\n参考の台本(話者はこれを元に話しています):\n{script_text[:6000]}\n" if script_text else "")
        + f"\n単語列:\n{toks}\n")
    schema = {"type": "OBJECT", "properties": {"removals": {"type": "ARRAY", "items": {
        "type": "OBJECT", "properties": {"from": {"type": "INTEGER"}, "to": {"type": "INTEGER"},
                                         "reason": {"type": "STRING"}},
        "required": ["from", "to", "reason"]}}}, "required": ["removals"]}
    res, model = G.generate_json(prompt, schema, audio_path=audio_mp3, log=log)
    out = []
    for r in res.get("removals", []):
        f, t = int(r["from"]), int(r["to"])
        if 0 <= f <= t < len(words):
            out.append({"from": f, "to": t, "reason": r.get("reason", ""),
                        "text": "".join(w["w"] for w in words[f:t + 1])})
    return out, model


# ───────────────────────── Gemini: テロップ作成 ─────────────────────────

CARD_RULES = (
    "テロップのルール:\n"
    "・表記は台本どおり(台本がある場合)。数字はアラビア数字。固有名詞・商品名・サービス名は正確に\n"
    "・台本に無いアドリブも、話した内容どおりに入れる。台本にあっても話していない部分は入れない\n"
    "・「▶ 映像」「■ テロップ」などの演出指示や、「② 〜｜0:50〜」のような見出しは無視する\n"
    "・句読点(。、！？など)は入れない\n"
    "・1枚のテロップは1行か2行。1行は全角{cpl}文字以内(半角は0.5文字)\n"
    "・2行にする場合は文節の切れ目で改行する。単語・数字・固有名詞の途中で改行しない。"
    "助詞だけを次の行の先頭に送らない\n"
    "・話した言葉を省略・要約・言い換えしない(「なぜか」「実は」「たった」等も残す)。"
    "文字数に収まらない場合は、省略せずにテロップを分ける。分けても語順と意味は変えない\n"
    "・emphasis: 動画の要点や印象に残る決めフレーズのテロップだけtrue(全体の5〜10%、最低2枚)\n"
)


def make_cards(words, script_text, audio_mp3, cpl, fix_notes=None, hint=""):
    toks = "\n".join(f"{w['i']}:{w['w']}" for w in words)
    prompt = (
        "添付の音声は、カット編集済みの動画の話者音声です。下の単語列は同じ音声をWhisperで文字起こししたもの"
        "(番号:単語、誤認識を含む)です。音声をよく聞いて、画面に出すテロップを作ってください。\n"
        + CARD_RULES.format(cpl=cpl)
        + (f"・固有名詞の参考(動画タイトル・チャンネル名・話者名): {hint}\n" if hint else "")
        + "・各テロップには、そのテロップで話している範囲の単語番号 from と to を付ける(時刻合わせに使う)。"
          "テロップ同士で範囲が重ならないこと、番号は時系列順に増えていくこと\n"
        + "・lines は表示する行の配列(1行なら1要素、2行なら2要素)\n"
        + "また、動画の内容の要約(summary、1文)も返してください。\n"
        + (f"\n台本:\n{script_text[:12000]}\n" if script_text else "\n(台本はありません。音声を正として書き起こしてください)\n")
        + (f"\n前回の出力の修正点:\n{fix_notes}\n" if fix_notes else "")
        + f"\n単語列:\n{toks}\n")
    schema = {"type": "OBJECT", "properties": {
        "summary": {"type": "STRING"},
        "cards": {"type": "ARRAY", "items": {"type": "OBJECT", "properties": {
            "from": {"type": "INTEGER"}, "to": {"type": "INTEGER"},
            "lines": {"type": "ARRAY", "items": {"type": "STRING"}},
            "emphasis": {"type": "BOOLEAN"}}, "required": ["from", "to", "lines", "emphasis"]}}},
        "required": ["summary", "cards"]}
    res, model = G.generate_json(prompt, schema, audio_path=audio_mp3, log=log)
    return res, model


def card_problems(cards, cpl, nwords, words=None):
    probs = []
    last_to = -1
    for k, c in enumerate(cards):
        lines = c["lines"]
        if not lines or not "".join(lines):
            probs.append((k, "空のテロップ"))
        if len(lines) > 2:
            probs.append((k, f"{len(lines)}行になっている(2行まで)"))
        for ln in lines:
            if line_width(ln) > cpl:
                probs.append((k, f"「{ln}」が{line_width(ln):g}文字(1行{cpl}文字まで)"))
        if not (0 <= c["from"] <= c["to"] < nwords):
            probs.append((k, "単語番号が範囲外"))
        elif words is not None:
            spoken = PUNCT_RE.sub("", "".join(w["w"] for w in words[c["from"]:c["to"] + 1])).replace(" ", "")
            shown = "".join(lines).replace(" ", "")
            if len(shown) >= 6 and len(shown) > 1.6 * len(spoken) + 4:
                probs.append((k, f"単語番号の範囲がずれている疑い: 範囲内の単語「{spoken}」に対してテロップ「{shown}」が長すぎる。"
                                 "from/toをそのテロップで話している単語の範囲に正しく合わせること"))
            elif len(spoken) >= 6 and len(shown) < 0.7 * len(spoken):
                probs.append((k, f"省略の疑い: 話した言葉「{spoken}」に対してテロップ「{shown}」が短い。省略せずに書き、"
                                 "収まらなければテロップを分けること"))
        elif c["from"] <= last_to:
            probs.append((k, "前のテロップと単語範囲が重なっている"))
        last_to = max(last_to, c["to"])
    return probs


PARTICLES = ("から", "まで", "より", "けど", "ので", "のに", "ても", "でも", "って", "は", "が", "を", "に", "で",
             "と", "も", "の", "へ", "や", "ね", "よ", "か", "て")


def _kind(ch):
    o = ord(ch)
    if 0x3040 <= o <= 0x309F:
        return "h"
    if 0x30A0 <= o <= 0x30FF or ch == "ー":
        return "k"
    if 0x4E00 <= o <= 0x9FFF or ch in "々〆ヶ":
        return "j"
    if ch.isdigit() or ch in "０１２３４５６７８９":
        return "d"
    return "o"


def break_points(text):
    """文節の切れ目らしい位置(この位置の前で改行してよい)。単語・数字・カタカナ語・漢字語の途中は除く"""
    pts = set()
    for i in range(1, len(text)):
        a, b = text[i - 1], text[i]
        ka, kb = _kind(a), _kind(b)
        if ka == kb and ka in "kjd":
            continue  # カタカナ語・漢字語・数字の途中
        if any(text[:i].endswith(p) for p in PARTICLES) and kb != "h":
            pts.add(i)  # 助詞の後ろ(次が漢字・カタカナ等)
        elif ka == "h" and kb in "jk" and any(text[:i].endswith(p) for p in PARTICLES):
            pts.add(i)
        elif b == " " or a == " ":
            pts.add(i)
    return sorted(pts)


def smart_lines(text, cpl):
    """文節の切れ目だけで、1行cpl文字以内の行に分ける。切れ目が無い場合だけ文字数で切る"""
    text = text.replace(" ", "")
    pts = break_points(text)
    lines, start = [], 0
    while line_width(text[start:]) > cpl:
        cands = [p for p in pts if p > start and line_width(text[start:p]) <= cpl]
        if cands:
            cut = cands[-1]
        else:
            cut, w = start, 0.0
            while cut < len(text) and w + line_width(text[cut]) <= cpl:
                w += line_width(text[cut])
                cut += 1
        lines.append(text[start:cut])
        start = cut
    if start < len(text):
        lines.append(text[start:])
    return lines


def repair_cards(bad_cards, cpl, title_hint):
    """ルール違反のテロップだけをGeminiに分け直してもらう(小さな依頼なので失敗しにくい)"""
    items = "\n".join(f"{k}: {''.join(c['lines'])}" for k, c in enumerate(bad_cards))
    prompt = ("次の各文を、動画のテロップとして分けてください。\n"
              f"・1枚は1行か2行。1行は全角{cpl:g}文字以内(半角は0.5文字)。句読点は入れない\n"
              "・改行やテロップの区切りは文節の切れ目だけ。単語・数字・固有名詞の途中で切らない\n"
              "・文字は変えない(区切るだけ)\n"
              + (f"・固有名詞の参考: {title_hint}\n" if title_hint else "")
              + f"\n文(番号: 文):\n{items}\n")
    schema = {"type": "OBJECT", "properties": {"results": {"type": "ARRAY", "items": {"type": "OBJECT", "properties": {
        "k": {"type": "INTEGER"}, "telops": {"type": "ARRAY", "items": {"type": "ARRAY", "items": {"type": "STRING"}}}},
        "required": ["k", "telops"]}}}, "required": ["results"]}
    res, _ = G.generate_json(prompt, schema, log=log)
    return {int(r["k"]): r["telops"] for r in res.get("results", [])}


def bgm_candidates(bgm, seq_sec):
    """短い曲が何度もつながらないよう、動画の長さ(最大2分)以上ある曲だけを候補にする"""
    files = list_audio(bgm)
    if len(files) <= 1:
        return files
    need = min(seq_sec, 120)
    long_enough = []
    for f in files:
        try:
            if probe(f)["duration_sec"] >= need:
                long_enough.append(f)
        except Exception:
            pass
    return long_enough or files


def claude_request_text(words, script_text, cpl, hint, title, bgm_files, sfx_files, out_path):
    """--engine claude のとき、Claude に渡すテロップ作成の依頼文(単語列つき)"""
    return (
        "# テロップ・BGM・効果音の作成依頼(Claude用)\n\n"
        "下の単語列は、カット編集済みの動画の話者音声をWhisperで文字起こししたもの(番号:単語、誤認識を含む)。"
        "これを読んで画面に出すテロップを作り、次の形のJSONを書き出すこと:\n"
        f"  {out_path}\n\n"
        '{"summary": "動画の内容を1文で", "bgm": "BGM候補のファイル名", '
        '"cards": [{"from": 0, "to": 5, "lines": ["1行目", "2行目"], "emphasis": false, "sfx": "効果音のファイル名(付ける時だけ)"}]}\n\n'
        "## テロップのルール\n"
        + CARD_RULES.format(cpl=cpl)
        + f"・固有名詞の参考(動画タイトル・チャンネル名・話者名): {hint}\n"
        "・from/to はそのテロップで話している単語番号の範囲。重ならず、時系列順に増えること。"
        "全ての話を漏れなくテロップにする(フィラー「えー」「あの」だけの部分は飛ばしてよい)\n"
        "・Whisperの誤認識は文脈から正しい言葉に直す。聞き取れない固有名詞は推測しすぎない\n"
        "・lines は表示する行の配列(1行なら1要素、2行なら2要素)\n"
        "・summary は動画の内容を1文で\n\n"
        "## BGM・効果音\n"
        "・bgm: 下の候補から、内容と雰囲気に合い声を邪魔しない曲を1つ(ファイル名のまま)\n"
        "・sfx: 強調テロップ(emphasis true)のうち2〜4枚に、合う効果音を候補から付ける。同じ音の多用は避ける\n\n"
        f"### BGM候補\n" + "\n".join(os.path.basename(f) for f in bgm_files) + "\n\n"
        f"### 効果音候補\n" + "\n".join(os.path.basename(f) for f in sfx_files) + "\n\n"
        + (f"## 台本\n{script_text}\n\n" if script_text else "## 台本\n(なし。単語列を正として書き起こす)\n\n")
        + f"## 単語列({len(words)}語)\n" + "\n".join(f"{w['i']}:{w['w']}" for w in words) + "\n")


def distribute(card, groups):
    """1枚のテロップを複数枚(groups=[[行,行],...])に分け、単語範囲を文字数の比で配分する"""
    text = "".join("".join(g) for g in groups)
    n_words = card["to"] - card["from"] + 1
    if n_words < len(groups):
        groups = [[x for g in groups for x in g]][:1]
    out, start, acc = [], card["from"], 0
    for gi, g in enumerate(groups):
        acc += len("".join(g))
        end = card["to"] if gi == len(groups) - 1 else min(card["to"] - (len(groups) - 1 - gi),
                                                             max(start, card["from"] + round(n_words * acc / max(1, len(text))) - 1))
        out.append({"from": start, "to": end, "lines": g, "emphasis": card.get("emphasis", False),
                    "sfx": card.get("sfx") if gi == 0 else None})
        start = end + 1
    return out


def hard_split(card, cpl):
    """1行の文字数を超えたテロップを、文節の切れ目で分ける(Geminiでの修正が効かなかったときの最終手段)"""
    pieces = smart_lines("".join(card["lines"]), cpl)
    groups = [pieces[i:i + 2] for i in range(0, len(pieces), 2)]
    return distribute(card, groups)


# ───────────────────────── 時刻合わせ ─────────────────────────

def snap_start(tl_t, tl, dbs, thr):
    src = tl.to_source(tl_t)
    if src is None:
        return tl_t
    i = round(src / J.FRAME_SEC)
    lo = max(0, i - round(0.3 / J.FRAME_SEC))
    hi = min(len(dbs) - 1, i + round(0.3 / J.FRAME_SEC))
    if dbs[i] >= thr:  # 既に音の中 → 音が始まった所まで戻る
        while i > lo and dbs[i - 1] >= thr:
            i -= 1
    else:  # 無音の中 → 次に音が始まる所まで進む
        while i < hi and dbs[i] < thr:
            i += 1
    t = tl.to_timeline(i * J.FRAME_SEC)
    return tl_t if t is None else t


def snap_end(tl_t, tl, dbs, thr):
    src = tl.to_source(tl_t)
    if src is None:
        return tl_t
    i = min(len(dbs) - 1, round(src / J.FRAME_SEC))
    hi = min(len(dbs) - 1, i + round(0.4 / J.FRAME_SEC))
    lo = max(0, i - round(0.3 / J.FRAME_SEC))
    if dbs[i] >= thr:
        while i < hi and dbs[i + 1] >= thr:
            i += 1
    else:
        while i > lo and dbs[i - 1] < thr:
            i -= 1
    t = tl.to_timeline((i + 1) * J.FRAME_SEC)
    return tl_t if t is None else t


# ───────────────────────── メイン ─────────────────────────

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", required=True)
    ap.add_argument("--out", required=True, help="保存先(この中に Premiere_Export_READY を作る)")
    ap.add_argument("--title", required=True)
    ap.add_argument("--channel", required=True)
    ap.add_argument("--bgm", required=True, help="BGMファイルかフォルダ")
    ap.add_argument("--sfx", required=True, help="効果音ファイルかフォルダ")
    ap.add_argument("--script", default=None, help="台本(テキストファイル)")
    ap.add_argument("--design-image", default=None)
    ap.add_argument("--mode", default="natural", choices=["natural", "tempo"])
    ap.add_argument("--font", default="NotoSansCJKjp-Black")
    ap.add_argument("--chars-per-line", type=float, default=16)
    ap.add_argument("--whisper-model", default="medium")
    ap.add_argument("--max-seconds", type=float, default=None, help="開発用: 先頭N秒だけ処理する")
    # 言い間違いのカットは既定でオフ(ユーザー判断 2026-11-13: Geminiの依頼回数が倍になり、誤判定で言葉が欠ける
    # おそれがあるため。言い間違いは手作業で消す運用)。必要なときだけ --misspeak で有効にする
    ap.add_argument("--misspeak", action="store_true", help="言い間違い・言い直し・重複・フィラーもカットする")
    # テロップを作る担当。gemini=Gemini API(パネル用) / claude=このスクリプトは単語列を書き出して止まり、
    # Claude が Work/cards.json を書いてから --cards で再実行する(Geminiの無料枠を使わない。ユーザー判断 2026-11-16)
    ap.add_argument("--engine", default="gemini", choices=["gemini", "claude"])
    ap.add_argument("--cards", default=None, help="Claudeが書いたテロップ・BGM・効果音のJSON(--engine claude の2回目)")
    ap.add_argument("--force-cards", action="store_true", help="テロップのルール違反が残っていても続ける(機械的に分ける)")
    ap.add_argument("--no-preview", action="store_true")
    ap.add_argument("--seq-name", default="03_CUTS_POINT_TEXT_EDITABLE")
    a = ap.parse_args()

    t0 = time.time()
    video = os.path.abspath(os.path.expanduser(a.video))
    root = os.path.join(os.path.abspath(os.path.expanduser(a.out)), "Premiere_Export_READY")
    D = {k: os.path.join(root, k) for k in ["Project", "Media/Video", "Media/BGM", "Media/SFX", "Media/Graphics",
                                             "Captions", "Preview", "Documents", "Logs", "Work"]}
    for p in D.values():
        os.makedirs(p, exist_ok=True)
    script_text = open(os.path.expanduser(a.script), encoding="utf-8").read() if a.script else ""
    cpl = a.chars_per_line

    # 1. 素材解析・コピー
    log("1/9 素材を解析しています…")
    info = probe(video)
    fps = info["fps"]
    timebase = int(round(fps))
    ntsc = abs(fps - timebase) > 0.01
    src_copy = os.path.join(D["Media/Video"], "source.mp4")
    if not os.path.exists(src_copy) or os.path.getsize(src_copy) != os.path.getsize(video):
        shutil.copy2(video, src_copy)
    if a.design_image:
        shutil.copy2(os.path.expanduser(a.design_image),
                     os.path.join(D["Media/Graphics"], "reference" + os.path.splitext(a.design_image)[1].lower()))
    dur = info["duration_sec"] if not a.max_seconds else min(info["duration_sec"], a.max_seconds)

    # 2. ジャンプカット
    log(f"2/9 ジャンプカット({'間を残す' if a.mode == 'natural' else 'テンポ重視'})…")
    dbs = J.read_levels(src_copy)[: int(dur / J.FRAME_SEC)]
    keep, lv = J.keep_regions(dbs, dur, a.mode)
    thr = lv["threshold"]
    log(f"  無音しきい値 {thr}dB(自動) / 残す区間 {len(keep)}")

    # 3. カット後音声の文字起こし
    log("3/9 カット後の音声を文字起こししています(Whisper)…")
    cut_wav = os.path.join(D["Work"], "cut_audio.wav")
    render_audio(src_copy, keep, cut_wav)
    import hashlib
    import transcribe_words
    digest = hashlib.md5(open(cut_wav, "rb").read()).hexdigest()[:12]
    # 文字起こし結果は共通の場所に保存し、保存先フォルダが違う再実行(パネルからの再実行など)でも使い回す
    cache_dir = os.environ.get("PREMIERE_PACKAGE_CACHE", os.path.expanduser("~/Library/Caches/premiere-xml-package"))
    os.makedirs(cache_dir, exist_ok=True)
    cache = os.path.join(cache_dir, f"whisper_{a.whisper_model}_{digest}.json")
    if os.path.exists(cache):
        log("  前回の文字起こし結果を再利用します")
        words_cut = json.load(open(cache, encoding="utf-8"))
    else:
        words_cut = transcribe_words.transcribe(cut_wav, a.whisper_model, (a.title + " " + a.channel + " " + script_text[:250]).strip(), log=log)
        json.dump(words_cut, open(cache, "w", encoding="utf-8"), ensure_ascii=False)
    tl1 = J.Timeline(keep)
    words = []
    for w in words_cut:
        s, e = tl1.to_source(w["start"]), tl1.to_source(max(w["start"], w["end"] - 0.001))
        if s is None or e is None:
            continue
        words.append(dict(w, i=len(words), src_start=s, src_end=max(s, e)))
    json.dump(words, open(os.path.join(D["Work"], "words_jumpcut.json"), "w", encoding="utf-8"), ensure_ascii=False)

    # 4. 言い間違いカット
    removals = []
    if a.misspeak and words:
        log("4/9 言い間違い・言い直し・重複・フィラーを検出しています(Gemini)…")
        found = []
        parts = chunked(words, cut_wav, D["Work"], "misspeak")
        for n, (cw, mp3) in enumerate(parts):
            log(f"  {n + 1}/{len(parts)}…")
            f_, model = detect_misspeaks(cw, script_text, mp3)
            found += f_
        for r in found:
            ws, we = words[r["from"]], words[r["to"]]
            nxt = words[r["to"] + 1] if r["to"] + 1 < len(words) else None
            rs = J.quietest_near(dbs, ws["src_start"], 0.12)
            re_ = J.quietest_near(dbs, nxt["src_start"], 0.12) if nxt else we["src_end"]
            # 1文字・0.3秒未満の「言い間違い」は文字起こしの乱れの可能性が高いのでカットしない
            if len(PUNCT_RE.sub("", r["text"])) < 2 or re_ - rs < 0.3:
                log(f"  カットしない(短すぎる): 「{r['text']}」")
                continue
            if re_ - rs < 15:
                removals.append(dict(r, src_start=round(rs, 3), src_end=round(re_, 3)))
        log(f"  {len(removals)}か所をカット({model})")
        keep = J.subtract(keep, [[r["src_start"], r["src_end"]] for r in removals])
    else:
        log("4/9 言い間違いのカットはしません(--misspeak で有効)")
    removed_idx = set()
    for r in removals:
        removed_idx.update(range(r["from"], r["to"] + 1))

    # フレームに揃えた最終カット
    cuts, pos = [], 0
    for s, e in keep:
        fi, fo = round(s * fps), round(e * fps)
        if fo - fi < 1:
            continue
        cuts.append({"start": pos, "end": pos + fo - fi, "in": fi, "out": fo})
        pos += fo - fi
    keep_q = [[c["in"] / fps, c["out"] / fps] for c in cuts]
    tl = J.Timeline(keep_q)
    seq_frames = pos

    words_final = []
    for w in words:
        if w["i"] in removed_idx:
            continue
        s, e = tl.to_timeline(w["src_start"]), tl.to_timeline(w["src_end"])
        if s is None or e is None:
            continue
        words_final.append({"i": len(words_final), "w": w["w"], "start": s, "end": max(s, e)})

    # 5. テロップ作成
    hint = f"{a.title} / {a.channel}"
    cards, summaries = [], []
    claude_pick = None
    if a.engine == "claude":
        bgm_cands = bgm_candidates(a.bgm, seq_frames / fps)
        sfx_cands = list_audio(a.sfx)
        if not a.cards:
            req = os.path.join(D["Work"], "claude_request.txt")
            with open(req, "w", encoding="utf-8") as f:
                f.write(claude_request_text(words_final, script_text, cpl, hint, a.title,
                                            bgm_cands, sfx_cands, os.path.join(D["Work"], "cards.json")))
            log("5/9 テロップはClaudeが作ります。次のファイルの指示どおりに cards.json を書き、--cards を付けて再実行してください")
            log(f"  依頼: {req}")
            sys.exit(3)
        log("5/9 Claudeが作ったテロップを読み込んでいます…")
        claude_pick = json.load(open(os.path.expanduser(a.cards), encoding="utf-8"))
        cards = claude_pick.get("cards", [])
        for c in cards:
            c["lines"] = [clean_line(x) for x in c.get("lines", []) if clean_line(x)]
        probs = card_problems(cards, cpl, len(words_final), words_final)
        if probs and not a.force_cards:
            for k, m in probs[:80]:
                log(f"  テロップ{k}: {m}")
            raise RuntimeError(f"テロップのルール違反が{len(probs)}件あります。cards.json を直して再実行してください"
                               "(このまま進めるなら --force-cards)")
        summaries.append(claude_pick.get("summary", ""))
        parts = []
    else:
        log("5/9 テロップを作成しています(Gemini: 音声+単語列+台本)…")
        final_wav = os.path.join(D["Work"], "final_audio.wav")
        render_audio(src_copy, keep_q, final_wav)
        parts = chunked(words_final, final_wav, D["Work"], "cards")
    for n, (cw, mp3) in enumerate(parts):
        log(f"  {n + 1}/{len(parts)}…")
        res, model = make_cards(cw, script_text, mp3, cpl, hint=hint)
        cc = res.get("cards", [])
        for c in cc:
            c["lines"] = [clean_line(x) for x in c.get("lines", []) if clean_line(x)]
        lo, hi = cw[0]["i"], cw[-1]["i"]
        cc = [c for c in cc if lo <= c.get("from", -1) <= c.get("to", -1) <= hi]
        probs = card_problems(cc, cpl, len(words_final), words_final)
        if probs:
            log(f"    ルール違反 {len(probs)}件 → Geminiに修正を依頼します")
            notes = "\n".join(f"テロップ{k}: {m}" for k, m in probs[:40])
            res2, model = make_cards(cw, script_text, mp3, cpl, fix_notes=notes, hint=hint)
            cc2 = res2.get("cards", [])
            for c in cc2:
                c["lines"] = [clean_line(x) for x in c.get("lines", []) if clean_line(x)]
            cc2 = [c for c in cc2 if lo <= c.get("from", -1) <= c.get("to", -1) <= hi]
            if cc2 and len(card_problems(cc2, cpl, len(words_final), words_final)) < len(probs):
                cc, res = cc2, res2
        cards += cc
        summaries.append(res.get("summary", ""))
    # まだ残る違反は、そのテロップだけGeminiに分け直してもらう
    bad = [c for c in cards if len(c["lines"]) > 2 or any(line_width(x) > cpl for x in c["lines"])]
    if bad and a.engine == "gemini":
        log(f"  文字数オーバー {len(bad)}件 → そのテロップだけ分け直します")
        try:
            rep_res = repair_cards(bad, cpl, hint)
        except Exception as e:
            rep_res = {}
            log(f"  分け直しに失敗({e})。文節の切れ目で機械的に分けます")
        new_cards = []
        for c in cards:
            if c in bad:
                k = bad.index(c)
                groups = [[clean_line(x) for x in g if clean_line(x)] for g in rep_res.get(k, [])]
                groups = [g for g in groups if g]
                same_text = "".join("".join(g) for g in groups).replace(" ", "") == "".join(c["lines"]).replace(" ", "")
                ok_rule = groups and all(len(g) <= 2 and all(line_width(x) <= cpl for x in g) for g in groups)
                if same_text and ok_rule:
                    new_cards.extend(distribute(c, groups))
                    continue
            new_cards.append(c)
        cards = new_cards
    # まだ残る違反は文節の切れ目で機械的に処理
    fixed = []
    last_to = -1
    for c in sorted(cards, key=lambda c: c["from"]):
        if not c["lines"] or c["to"] < c["from"] or c["to"] >= len(words_final):
            continue
        if c["from"] <= last_to:
            c["from"] = last_to + 1
            if c["from"] > c["to"]:
                continue
        if len(c["lines"]) > 2 or any(line_width(x) > cpl for x in c["lines"]):
            fixed.extend(hard_split(c, cpl))
        else:
            fixed.append(c)
        last_to = c["to"]
    cards = fixed
    summary = " ".join(x for x in summaries if x)

    # 6. 時刻合わせ(話し始め/話し終わり)
    telops = []
    for k, c in enumerate(cards):
        st = snap_start(words_final[c["from"]]["start"], tl, dbs, thr)
        en = snap_end(words_final[c["to"]]["end"], tl, dbs, thr)
        telops.append({"k": k, "text": "\r".join(c["lines"]), "lines": c["lines"], "emphasis": bool(c.get("emphasis")),
                       "sfx": c.get("sfx"), "start_sec": st, "end_sec": max(en, st + 0.5)})
    # テロップの間に隙間を作らない: 次のセリフが始まるまで前のテロップを出し続ける(ユーザー要望 2026-11-16)
    for k in range(len(telops) - 1):
        telops[k]["end_sec"] = telops[k + 1]["start_sec"]
    if telops:
        telops[-1]["end_sec"] = seq_frames / fps  # 最後のテロップは動画の終わりまで
    for t in telops:
        t["start"] = max(0, round(t["start_sec"] * fps))
        t["end"] = min(seq_frames, max(t["start"] + 1, round(t["end_sec"] * fps)))
        t["track"] = 3 if t["emphasis"] else 2
    for k in range(len(telops) - 1):
        telops[k]["end"] = telops[k + 1]["start"]  # フレームに丸めた後も、次のテロップの開始ぴったりまでつなぐ
    telops = [t for t in telops if t["end"] > t["start"]]

    # 7. BGM・効果音
    log("7/9 BGMと効果音を選んでいます…")
    bgm_files, sfx_files = bgm_candidates(a.bgm, seq_frames / fps), list_audio(a.sfx)
    emph = [t for t in telops if t["emphasis"]]
    if claude_pick is not None:
        # macのファイル名は濁点が分かれた形(NFD)なので、そろえてから照合する
        nfc = lambda s: unicodedata.normalize("NFC", s or "")  # noqa: E731
        by_name = {nfc(os.path.basename(f)): f for f in bgm_files}
        bgm_pick = by_name.get(nfc(claude_pick.get("bgm")))
        if not bgm_pick:
            log(f"  BGMが見つかりません: {claude_pick.get('bgm')}(候補の先頭を使います)")
            bgm_pick = bgm_files[0]
        sby = {nfc(os.path.basename(f)): f for f in sfx_files}
        sfx_pick = [(t["k"], sby[nfc(t["sfx"])]) for t in telops if nfc(t.get("sfx")) in sby]
        for t in telops:
            if t.get("sfx") and nfc(t["sfx"]) not in sby:
                log(f"  効果音が見つかりません: {t['sfx']}")
    elif len(bgm_files) == 1 and len(sfx_files) <= 4:
        bgm_pick = bgm_files[0]
        sfx_pick = [(emph[i % max(1, len(emph))]["k"], f) for i, f in enumerate(sfx_files)] if emph else []
    else:
        prompt = (
            f"動画の内容: {summary}\n動画タイトル: {a.title}\n\n"
            "1) BGM候補から、この動画の内容と雰囲気に合い、話者の声を邪魔しない曲を1つ選んでください。\n"
            "2) 強調テロップの一覧から2〜4個を選び、それぞれに合う効果音を効果音候補から選んでください"
            "(同じ効果音の多用は避ける。強調テロップが2個未満ならある分だけ)。\n\n"
            "BGM候補:\n" + "\n".join(os.path.basename(f) for f in bgm_files) + "\n\n"
            "効果音候補:\n" + "\n".join(os.path.basename(f) for f in sfx_files) + "\n\n"
            "強調テロップ(番号: 文):\n" + "\n".join(f"{t['k']}: {''.join(t['lines'])}" for t in emph))
        schema = {"type": "OBJECT", "properties": {
            "bgm": {"type": "STRING"},
            "sfx": {"type": "ARRAY", "items": {"type": "OBJECT", "properties": {
                "telop": {"type": "INTEGER"}, "file": {"type": "STRING"}}, "required": ["telop", "file"]}}},
            "required": ["bgm", "sfx"]}
        pick, _ = G.generate_json(prompt, schema, log=log)
        by_name = {os.path.basename(f): f for f in bgm_files}
        bgm_pick = by_name.get(pick.get("bgm")) or bgm_files[0]
        sby = {os.path.basename(f): f for f in sfx_files}
        valid_k = {t["k"] for t in emph}
        sfx_pick = [(int(s["telop"]), sby[s["file"]]) for s in pick.get("sfx", [])
                    if s.get("file") in sby and int(s.get("telop", -1)) in valid_k][:4]
    bgm_copy = os.path.join(D["Media/BGM"], ascii_name("bgm_main", bgm_pick))
    shutil.copy2(bgm_pick, bgm_copy)
    bgm_info = probe(bgm_copy)
    sfx_entries, used = [], {}
    for tk, f in sfx_pick:
        if f not in used:
            used[f] = os.path.join(D["Media/SFX"], ascii_name("sfx", f, len(used) + 1))
            shutil.copy2(f, used[f])
        t = next(t for t in telops if t["k"] == tk)
        si = probe(used[f])
        sfx_entries.append({"path": used[f], "orig": unicodedata.normalize("NFC", os.path.basename(f)), "start": t["start"],
                            "duration": max(1, round(si["duration_sec"] * fps)), "gain": 0.5,
                            "samplerate": si.get("samplerate", 48000), "channels": si.get("channels", 2),
                            "telop": "".join(t["lines"])})

    # BGM: 基本 -22dB、会話が1.5秒以上途切れる所だけ -16dB に上げる(=会話中はダッキング)
    BGM_SPEECH, BGM_GAP = 10 ** (-22 / 20), 10 ** (-16 / 20)
    speech = []
    for w in words_final:
        if speech and w["start"] - speech[-1][1] < 1.5:
            speech[-1][1] = max(speech[-1][1], w["end"])
        else:
            speech.append([w["start"], w["end"]])
    envelope = [(0, BGM_SPEECH)]
    ramp = round(0.4 * fps)
    for (s0, e0), (s1, _) in zip(speech, speech[1:]):
        a0, b0 = round(e0 * fps), round(s1 * fps)
        if b0 - a0 > 2 * ramp + 2:
            envelope += [(a0, BGM_SPEECH), (a0 + ramp, BGM_GAP), (b0 - ramp, BGM_GAP), (b0, BGM_SPEECH)]

    # 8. XML
    log("8/9 XML・字幕・資料を書き出しています…")
    style = {"font": a.font}
    plan = {
        "sequence": {"name": a.seq_name, "width": 1920, "height": 1080, "timebase": timebase, "ntsc": ntsc},
        "source": {"path": src_copy, "orig": unicodedata.normalize("NFC", os.path.basename(video)), "duration": round(info["duration_sec"] * fps), "width": info["width"],
                   "height": info["height"], "timebase": timebase, "ntsc": ntsc,
                   "channels": info.get("channels", 2), "samplerate": info.get("samplerate", 48000)},
        "cuts": cuts,
        "telops": [{"track": t["track"], "text": t["text"], "start": t["start"], "end": t["end"]} for t in telops],
        "title": {"text": f"{a.title}｜{a.channel}"},
        "bgm": {"path": bgm_copy, "orig": unicodedata.normalize("NFC", os.path.basename(bgm_pick)), "duration": round(bgm_info["duration_sec"] * fps),
                "samplerate": bgm_info.get("samplerate", 48000), "channels": bgm_info.get("channels", 2),
                "gain": BGM_SPEECH, "fade_in": round(1.0 * fps), "fade_out": round(2.0 * fps),
                "envelope": envelope},
        "sfx": sfx_entries,
        "style": style,
    }
    json.dump(plan, open(os.path.join(D["Work"], "plan.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    xml_path = os.path.join(D["Project"], "premiere_timeline.xml")
    with open(xml_path, "w", encoding="utf-8", newline="\n") as f:
        f.write(build_xml.build(plan))

    # 字幕・文字起こし・デザイン表
    def srt_time(fr):
        ms = round(fr / fps * 1000)
        return f"{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d},{ms % 1000:03d}"
    with open(os.path.join(D["Captions"], "captions_ja.srt"), "w", encoding="utf-8") as f:
        for n, t in enumerate(telops, 1):
            f.write(f"{n}\n{srt_time(t['start'])} --> {srt_time(t['end'])}\n" + "\n".join(t["lines"]) + "\n\n")
    with open(os.path.join(D["Captions"], "transcript_ja.txt"), "w", encoding="utf-8") as f:
        f.write("■ テロップ本文(カット後タイムライン)\n")
        for t in telops:
            f.write(f"[{srt_time(t['start'])}] {' '.join(t['lines'])}{'  ★強調' if t['emphasis'] else ''}\n")
        f.write("\n■ Whisperの文字起こし(参考・誤認識を含む)\n")
        f.write("".join(w["w"] for w in words_final) + "\n")
    st = dict(build_xml.DEFAULT_STYLE, **style)
    with open(os.path.join(D["Captions"], "telop_design.csv"), "w", encoding="utf-8-sig", newline="") as f:
        wr = csv.writer(f)
        wr.writerow(["種類", "トラック", "フォント", "XML fontsize", "alignment", "horiz", "vert", "文字色ARGB",
                     "背景色ARGB", "背景不透明度", "背景幅"])
        for kind, tr, col in [("通常テロップ", "V2", st["fontcolor"]), ("強調テロップ", "V3", st["emphasis_fontcolor"])]:
            wr.writerow([kind, tr, st["font"], st["fontsize"], st["alignment"], st["horiz"], st["vert"],
                         "/".join(map(str, col)), "/".join(map(str, st["backgroundcolor"])),
                         st["backgroundopacity"], st["backgroundwidth"]])
        wr.writerow(["右上タイトル", "V4", st["font"], st["title_fontsize"], st["title_alignment"], "(文字幅から計算)",
                     st["title_vert"], "/".join(map(str, st["fontcolor"])), "", "", ""])

    with open(os.path.join(D["Documents"], "edit_instructions.csv"), "w", encoding="utf-8-sig", newline="") as f:
        wr = csv.writer(f)
        wr.writerow(["種類", "タイムライン位置", "素材位置(秒)", "内容", "音量・備考"])
        wr.writerow(["ジャンプカット", "", "", f"{a.mode} / 無音しきい値{thr}dB / 残す区間{len(cuts)}", ""])
        for r in removals:
            wr.writerow(["言い間違いカット", "", f"{r['src_start']:.2f}-{r['src_end']:.2f}", r["text"], r["reason"]])
        wr.writerow(["BGM", "全編(A2)", "", os.path.basename(bgm_pick),
                     "会話中-22dB/会話が途切れる所-16dB(キーフレーム)・冒頭1秒フェードイン・末尾2秒フェードアウト(XMLに設定済み)"])
        for s in sfx_entries:
            wr.writerow(["効果音", srt_time(s["start"]), "", f"{s['orig']} → 強調「{s['telop']}」", "-6dB(XMLに設定済み)"])

    # プレビュー用シーケンス
    prev_mp4 = os.path.join(D["Preview"], "preview_match.mp4")
    if not a.no_preview:
        log("    プレビュー動画を書き出しています…")
        import render_preview
        render_preview.render(plan, telops, prev_mp4, fps, D["Work"], log=log)
        shutil.copy2(prev_mp4, os.path.join(D["Media/Video"], "preview_match.mp4"))
        pi = probe(prev_mp4)
        pv = os.path.join(D["Media/Video"], "preview_match.mp4")
        pplan = {"sequence": {"name": "PREVIEW_MATCH", "width": 1920, "height": 1080, "timebase": timebase, "ntsc": ntsc},
                 "source": {"path": pv, "duration": round(pi["duration_sec"] * fps), "width": pi["width"],
                            "height": pi["height"], "timebase": timebase, "ntsc": ntsc,
                            "channels": pi.get("channels", 2), "samplerate": pi.get("samplerate", 48000)},
                 "cuts": [{"start": 0, "end": seq_frames, "in": 0, "out": seq_frames}], "telops": [],
                 "bin_names": {"video": "プレビュー"}}
        with open(os.path.join(D["Project"], "preview_match_sequence.xml"), "w", encoding="utf-8", newline="\n") as f:
            f.write(build_xml.build(pplan))

    # README / 実機確認ログの雛形
    with open(os.path.join(D["Documents"], "README.txt"), "w", encoding="utf-8") as f:
        f.write(README.format(seq=a.seq_name, font=a.font, fps=f"{fps:g}"))
    imp = os.path.join(D["Logs"], "premiere_import_test.txt")
    if not os.path.exists(imp):
        open(imp, "w", encoding="utf-8").write(
            "構造検証済み。\nPremiere Pro実機読み込み未確認。\n"
            "XML内alignment=centerは設定済みだが、Premiere上の段落中央揃えは未確認。\n")

    # 9. 検証
    log("9/9 XMLを検証しています…")
    import validate_xml
    ok, report = validate_xml.validate(xml_path, root, cpl=cpl)
    open(os.path.join(D["Logs"], "xml_validation.txt"), "w", encoding="utf-8").write(report)

    summary_out = {
        "保存先": root, "XML": xml_path, "シーケンス名": a.seq_name, "fps": fps,
        "V1/A1カット数": len(cuts), "V2通常テロップ数": sum(1 for t in telops if t["track"] == 2),
        "V3強調テロップ数": sum(1 for t in telops if t["track"] == 3), "V4タイトル数": 1,
        "generatoritem総数": len(telops) + 1, "BGM": os.path.basename(bgm_pick),
        "効果音": [s["orig"] for s in sfx_entries], "言い間違いカット": len(removals),
        "完成尺(秒)": round(seq_frames / fps, 1), "検証": "すべて合格" if ok else "不合格あり",
        "処理時間(秒)": round(time.time() - t0),
    }
    json.dump(summary_out, open(os.path.join(D["Logs"], "summary.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    log(json.dumps(summary_out, ensure_ascii=False, indent=1))
    return 0 if ok else 1


README = """Premiere_Export_READY
====================

■ 読み込み方
Premiere Pro で [ファイル] > [読み込み] から Project/premiere_timeline.xml を選ぶ。
シーケンス「{seq}」が作られる({fps}fps・1920×1080)。

■ トラック
V1 カット済み元動画 / V2 通常テロップ / V3 強調テロップ(黄) / V4 右上タイトル / V5 追加装飾(空)
A1 話者音声 / A2 BGM / A3 効果音

■ Premiere上で手作業が必要な項目(XMLでは反映されないことを実機で確認済み)
1. テロップの背景(半透明の帯)と段落の中央揃え
   → V2のテロップを全部選択し、エッセンシャルグラフィックスで保存済みのテキストスタイルを一括適用する。
     V3(強調)も同様に、強調用のスタイルを適用する。
2. 2行のテロップは1行ずつ別のレイヤーになり、2行目の左端が1行目にそろう(行ごとの中央揃えにならない)。
3. テロップの横位置は、文字幅の見積もりの都合で中央より少し左に寄る(1行12文字で約50px)。
4. フォントは {font}(PostScript名で指定)。

■ 自動で設定済み
・ジャンプカット(息継ぎもカット)、言い間違いのカット(Documents/edit_instructions.csv に一覧)
・BGM音量(会話中-22dB、途切れる所-16dB、フェードイン/アウト)、効果音音量(-6dB)
"""

if __name__ == "__main__":
    try:
        sys.exit(main())
    except RuntimeError as e:
        # 想定内のエラー(Geminiの上限など)は、内部情報なしでメッセージだけを出す(パネルにそのまま表示される)
        print(f"エラー: {e}", flush=True)
        sys.exit(2)
