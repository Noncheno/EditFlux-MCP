#!/usr/bin/env python3
"""
validate_xml.py
premiere_timeline.xml と成果物フォルダを31項目で検証し、結果をテキストで返す。

ユーザーとの取り決めで、元の仕様から次の2点を変えている:
- フレームレートは素材に合わせる(23.976固定にしない)
- 話者テロップは1枚1〜2行・1行16文字以内。2行の場合の改行はCR(&#13;)1か所だけ許可(LFは不可)

使い方: python3 validate_xml.py --xml Project/premiere_timeline.xml --root Premiere_Export_READY
"""

import argparse
import os
import sys
import urllib.parse
import xml.etree.ElementTree as ET

REQUIRED = [
    "Project/premiere_timeline.xml", "Project/preview_match_sequence.xml",
    "Media/Video/source.mp4", "Media/Video/preview_match.mp4",
    "Captions/captions_ja.srt", "Captions/transcript_ja.txt", "Captions/telop_design.csv",
    "Preview/preview_match.mp4", "Documents/README.txt", "Documents/edit_instructions.csv",
    "Logs/premiere_import_test.txt",
]


def width(s):
    return sum(1.0 if ord(c) > 0xFF else 0.5 for c in s)


def validate(xml_path, root, cpl=16):
    res = []

    def check(n, name, ok, detail=""):
        res.append((n, name, bool(ok), detail))

    raw = open(xml_path, "rb").read()
    try:
        text = raw.decode("utf-8")
        utf8 = True
    except UnicodeDecodeError:
        text, utf8 = "", False
    check(1, "UTF-8・BOMなし", utf8 and not raw.startswith(b"\xef\xbb\xbf"))
    check(2, 'xmeml version="5"', '<xmeml version="5">' in text)
    try:
        tree = ET.fromstring(raw)
        parsed = True
    except ET.ParseError as e:
        tree, parsed = None, False
        check(3, "XMLとしてパース可能", False, str(e))
    if not parsed:
        return False, "\n".join(f"{n:2d}. [{'OK' if ok else 'NG'}] {nm} {d}" for n, nm, ok, d in res)
    check(3, "XMLとしてパース可能", True)
    seqs = tree.findall(".//sequence")
    check(4, "sequenceが1個", len(seqs) == 1, f"{len(seqs)}個")
    seq = seqs[0]
    sc = seq.find("media/video/format/samplecharacteristics")
    w, h = sc.findtext("width"), sc.findtext("height")
    check(5, "1920×1080", (w, h) == ("1920", "1080"), f"{w}×{h}")
    tb, ntsc = seq.findtext("rate/timebase"), seq.findtext("rate/ntsc")
    src_tb = None
    f1 = tree.find(".//file[@id='file-1']/rate/timebase")
    if f1 is not None:
        src_tb = f1.text
    check(6, "timebase/ntscが素材のフレームレートと一致", tb == src_tb and ntsc in ("TRUE", "FALSE"),
          f"timebase={tb} ntsc={ntsc}(素材 {src_tb})")
    sr = seq.findtext("media/audio/format/samplecharacteristics/samplerate")
    ch = seq.findtext("media/audio/numOutputChannels")
    check(7, "audio=48000Hz stereo", sr == "48000" and ch == "2", f"{sr}Hz {ch}ch")

    vt = seq.findall("media/video/track")
    at = seq.findall("media/audio/track")
    v1 = vt[0].findall("clipitem") if vt else []
    a1 = at[0].findall("clipitem") if at else []
    check(8, "V1とA1のカット数が一致", len(v1) == len(a1) and len(v1) > 1, f"V1={len(v1)} A1={len(a1)}")
    key = lambda c: tuple(int(c.findtext(k)) for k in ("start", "end", "in", "out"))
    check(9, "V1とA1の編集点が一致", [key(c) for c in v1] == [key(c) for c in a1])
    links_ok = True
    for vc, ac in zip(v1, a1):
        vrefs = {l.findtext("linkclipref") for l in vc.findall("link")}
        arefs = {l.findtext("linkclipref") for l in ac.findall("link")}
        need = {vc.get("id"), ac.get("id")}
        for l in vc.findall("link") + ac.findall("link"):
            if None in [l.findtext(k) for k in ("linkclipref", "mediatype", "trackindex", "clipindex", "groupindex")]:
                links_ok = False
        if not (need <= vrefs and need <= arefs):
            links_ok = False
    check(10, "全V1/A1ペアに相互link", links_ok and len(v1) > 0)
    clips = seq.findall(".//clipitem")
    check(11, "全clipitemでstart < end", all(int(c.findtext("start")) < int(c.findtext("end")) for c in clips))
    check(12, "全clipitemでout - in = end - start",
          all(int(c.findtext("out")) - int(c.findtext("in")) == int(c.findtext("end")) - int(c.findtext("start")) for c in clips))
    check(13, "A2にBGMが存在", len(at) > 1 and len(at[1].findall("clipitem")) > 0)
    check(14, "A3に効果音が存在", len(at) > 2 and len(at[2].findall("clipitem")) > 0)
    g2 = vt[1].findall("generatoritem") if len(vt) > 1 else []
    g3 = vt[2].findall("generatoritem") if len(vt) > 2 else []
    g4 = vt[3].findall("generatoritem") if len(vt) > 3 else []
    check(15, "V2に通常generatoritemが存在", len(g2) > 0, f"{len(g2)}個")
    check(16, "V3に強調generatoritemが存在", len(g3) > 0, f"{len(g3)}個")
    check(17, "V4に右上タイトルgeneratoritemが存在", len(g4) == 1, f"{len(g4)}個")
    gens = seq.findall(".//generatoritem")
    check(18, "全Text GeneratorのeffectidがText", all(g.findtext("effect/effectid") == "Text" for g in gens))
    check(19, "全Text Generatorのeffecttypeがgenerator", all(g.findtext("effect/effecttype") == "generator" for g in gens))
    check(20, "全Text Generatorのmediatypeがvideo", all(g.findtext("effect/mediatype") == "video" for g in gens))

    def strval(g):
        for p in g.findall("effect/parameter"):
            if p.findtext("parameterid") == "str":
                return p.findtext("value") or ""
        return ""
    strs = [(g, strval(g)) for g in gens]
    check(21, "strが空ではない", all(s.strip() for _, s in strs))
    # ElementTreeは&#13;をCRとして読む。LFは不可、CRは2行テロップの改行として1か所まで
    bad_nl = [s for _, s in strs if "\n" in s or s.count("\r") > 1]
    check(22, "strにLFが無い・CR改行は1か所まで(2行テロップ)", not bad_nl, f"違反{len(bad_nl)}件")
    bad_sp = [s for _, s in strs if any(c in s for c in " 　\t")]
    check(23, "strにNBSP・全角スペース・タブが無い", not bad_sp, f"違反{len(bad_sp)}件")
    over = []
    for g, s in strs:
        if g in g4:
            continue
        lines = s.split("\r")
        if len(lines) > 2 or any(width(l) > cpl for l in lines):
            over.append(s.replace("\r", "/"))
    check(24, f"話者テロップが1〜2行・1行{cpl:g}文字以内", not over, ("違反: " + "、".join(over[:5])) if over else "")
    ids = [e.get("id") for e in seq.iter() if e.tag in ("clipitem", "generatoritem")]
    check(25, "全clipitem/generatoritemのIDが一意", len(ids) == len(set(ids)))
    check(26, "全generatoritemでstart < end", all(int(g.findtext("start")) < int(g.findtext("end")) for g in gens))
    seq_dur = int(seq.findtext("duration"))
    last_end = max(int(c.findtext("end")) for c in v1) if v1 else 0
    gen_ok = all(int(g.findtext("in")) == 0 and int(g.findtext("out")) == int(g.findtext("end")) - int(g.findtext("start"))
                 and int(g.findtext("end")) <= seq_dur for g in gens)
    overlap = False
    for track in (g2, g3):
        spans = sorted((int(g.findtext("start")), int(g.findtext("end"))) for g in track)
        overlap |= any(b[0] < a[1] for a, b in zip(spans, spans[1:]))
    check(27, "全generatoritemでin=0・out-in=end-start・尺内・同トラックで重ならない",
          gen_ok and not overlap and seq_dur == last_end, f"sequence duration={seq_dur} 最終end={last_end}")
    check(28, "clipitem直下にText effectが無い",
          not any(e.findtext("effectid") == "Text" for c in clips for e in c.findall("effect")))
    missing = []
    for pu in {e.text for e in tree.iter("pathurl")}:
        p = urllib.parse.unquote(pu.replace("file://localhost", ""))
        if not os.path.exists(p):
            missing.append(p)
    check(29, "全pathurlが実在ファイルを参照", not missing, ", ".join(missing))
    garbled = "�" in text or any(m in text for m in ("ã\u0081", "ã\u0083", "â€"))
    check(30, "日本語が文字化けしていない", not garbled)
    miss = [r for r in REQUIRED if not os.path.exists(os.path.join(root, r))]
    check(31, "必須成果物がすべて存在", not miss, ", ".join(miss))

    ok = all(r[2] for r in res)
    lines = [f"XML構造検証: {xml_path}", ""]
    lines += [f"{n:2d}. [{'OK' if o else 'NG'}] {nm}{('  (' + d + ')') if d else ''}" for n, nm, o, d in res]
    lines += ["", "結果: " + ("すべて合格" if ok else f"不合格 {sum(1 for r in res if not r[2])}項目")]
    return ok, "\n".join(lines) + "\n"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--xml", required=True)
    ap.add_argument("--root", required=True)
    ap.add_argument("--cpl", type=float, default=16)
    a = ap.parse_args()
    ok, rep = validate(a.xml, a.root, a.cpl)
    print(rep)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
