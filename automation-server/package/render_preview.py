#!/usr/bin/env python3
"""
render_preview.py
編集プランどおりのプレビュー動画(preview_match.mp4)を ffmpeg で書き出す。
カット・テロップ(焼き込み)・右上タイトル・BGM・効果音を反映した確認用。Premiere上の見た目とは
フォントの描画や位置が多少異なる(このffmpegには字幕描画フィルタが無いため、テロップはPillowで画像化して重ねる)。
"""

import os
import subprocess

FONT_FILES = [
    os.path.expanduser("~/Library/Fonts/NotoSansCJKjp-VF.otf"),
    "/System/Library/Fonts/ヒラギノ角ゴシック W8.ttc",
]


def _font(size):
    from PIL import ImageFont
    for p in FONT_FILES:
        if os.path.exists(p):
            f = ImageFont.truetype(p, size)
            try:
                f.set_variation_by_name("Black")
            except Exception:
                pass
            return f
    return ImageFont.load_default()


def _telop_png(lines, color, path, W=1920, H=300):
    from PIL import Image, ImageDraw
    im = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    f = _font(70)
    lh = 86
    widths = [d.textlength(ln, font=f) for ln in lines]
    bw, bh = max(widths) + 60, lh * len(lines) + 30
    y0 = H - 40 - bh
    d.rounded_rectangle([(W - bw) / 2, y0, (W + bw) / 2, y0 + bh], radius=12, fill=(63, 63, 63, 179))
    for i, (ln, w) in enumerate(zip(lines, widths)):
        d.text(((W - w) / 2, y0 + 15 + i * lh), ln, font=f, fill=color)
    im.save(path)


def _title_png(text, path, W=1920, H=120):
    from PIL import Image, ImageDraw
    im = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    f = _font(40)
    w = d.textlength(text, font=f)
    d.text((W - 48 - w, 40), text, font=f, fill=(255, 255, 255, 255))
    im.save(path)


def render(plan, telops, out_path, fps, work, log=print):
    pdir = os.path.join(work, "preview_png")
    os.makedirs(pdir, exist_ok=True)
    seq_frames = plan["cuts"][-1]["end"]
    # テロップ画像の連番(隙間は透明画像)を concat で1本の映像にする
    blank = os.path.join(pdir, "blank.png")
    from PIL import Image
    Image.new("RGBA", (1920, 300), (0, 0, 0, 0)).save(blank)
    entries, cur = [], 0
    for k, t in enumerate(telops):
        if t["start"] > cur:
            entries.append((blank, (t["start"] - cur) / fps))
        p = os.path.join(pdir, f"t_{k:04d}.png")
        _telop_png(t["lines"], (255, 212, 59, 255) if t["track"] == 3 else (255, 255, 255, 255), p)
        entries.append((p, (t["end"] - t["start"]) / fps))
        cur = t["end"]
    if cur < seq_frames:
        entries.append((blank, (seq_frames - cur) / fps))
    lst = os.path.join(pdir, "telops.txt")
    with open(lst, "w") as f:
        for p, d in entries:
            f.write(f"file '{p}'\nduration {d:.4f}\n")
        f.write(f"file '{entries[-1][0]}'\n")
    title_png = os.path.join(pdir, "title.png")
    _title_png(plan["title"]["text"], title_png)

    src = plan["source"]["path"]
    total = seq_frames / fps
    # 1) カット済みの映像を区間ごとに書き出してつなぐ(区間数が多くても動くよう、1つの式にまとめない)
    sdir = os.path.join(work, "preview_segments")
    os.makedirs(sdir, exist_ok=True)
    seg_list = os.path.join(sdir, "segments.txt")
    with open(seg_list, "w") as lf:
        for k, c in enumerate(plan["cuts"]):
            seg = os.path.join(sdir, f"seg_{k:04d}.mp4")
            n = c["out"] - c["in"]
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", f"{c['in'] / fps:.6f}", "-i", src, "-frames:v", str(n),
                            "-vf", f"fps={fps},scale=1920:1080:force_original_aspect_ratio=decrease,"
                                   "pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1",
                            "-an", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "18", "-pix_fmt", "yuv420p", seg],
                           check=True)
            lf.write(f"file '{seg}'\n")
    cut_video = os.path.join(sdir, "cut_video.mp4")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", seg_list, "-c", "copy", cut_video],
                   check=True)
    # 2) 話者音声(カット済み)は Python で切り出して wav にする
    import make_package
    speech = os.path.join(sdir, "speech.wav")
    make_package.write_cut_wav(src, [[c["in"] / fps, c["out"] / fps] for c in plan["cuts"]], speech, sr=48000, ch=2)
    bgm = plan["bgm"]
    sfx = plan.get("sfx", [])
    inputs = ["-i", cut_video, "-f", "concat", "-safe", "0", "-i", lst, "-loop", "1", "-i", title_png,
              "-i", speech, "-stream_loop", "-1", "-i", bgm["path"]]
    for x in sfx:
        inputs += ["-i", x["path"]]
    fc = (f"[1:v]fps={fps},format=rgba[tel];[0:v][tel]overlay=0:780:eof_action=pass[v1];"
          f"[v1][2:v]overlay=0:0:shortest=1[v];"
          f"[4:a]volume=-22dB,afade=t=in:d=1,afade=t=out:st={max(0, total - 2):.3f}:d=2,atrim=0:{total:.3f}[bg];")
    mix = "[3:a][bg]"
    for i, x in enumerate(sfx):
        ms = round(x["start"] / fps * 1000)
        fc += f"[{5 + i}:a]volume=-6dB,adelay={ms}|{ms}[s{i}];"
        mix += f"[s{i}]"
    fc += f"{mix}amix=inputs={2 + len(sfx)}:normalize=0:duration=first[a]"
    cmd = ["ffmpeg", "-v", "error", "-y"] + inputs + [
        "-filter_complex", fc, "-map", "[v]", "-map", "[a]", "-t", f"{total:.3f}",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k", "-ar", "48000", out_path]
    log(f"    ffmpegでプレビューを書き出し中({total:.0f}秒分)…")
    subprocess.run(cmd, check=True)
