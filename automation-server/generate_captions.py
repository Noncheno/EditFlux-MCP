#!/usr/bin/env python3
"""
generate_captions.py
Whisperで音声を文字起こしし、テロップ用のSRTとJSONを生成する。

依存:
  pip install openai-whisper
  ffmpeg がPATH上にあること(Whisperが内部で使用)

使い方:
  python3 generate_captions.py --input audio.wav --output-dir ./out \
      --language ja --model medium --max-chars-per-line 18
"""

import argparse
import json
import os
import sys


def wrap_text(text, max_chars):
    """日本語前提:文字数ベースで折り返す。句読点付近で改行を優先する。"""
    text = text.strip()
    if len(text) <= max_chars:
        return [text] if text else []

    break_chars = "。、！？,.!? 　"
    search_start = max(0, max_chars - 8)
    best = -1
    for i in range(min(max_chars, len(text) - 1), search_start, -1):
        if text[i] in break_chars:
            best = i + 1
            break
    if best == -1:
        best = max_chars

    first = text[:best].strip()
    rest = text[best:].strip()
    if not rest:
        return [first]
    return [first] + wrap_text(rest, max_chars)


def format_srt_time(seconds):
    millis = int(round((seconds - int(seconds)) * 1000))
    if millis == 1000:
        seconds += 1
        millis = 0
    total = int(seconds)
    h, rem = divmod(total, 3600)
    m, s = divmod(rem, 60)
    return f"{h:02d}:{m:02d}:{s:02d},{millis:03d}"


def main():
    parser = argparse.ArgumentParser(description="Whisperでテロップ用SRT/JSONを生成する")
    parser.add_argument("--input", required=True, help="音声または動画ファイルのパス")
    parser.add_argument("--output-dir", required=True, help="出力先ディレクトリ")
    parser.add_argument("--language", default="ja", help="言語コード(既定: ja)")
    parser.add_argument("--model", default="medium", help="Whisperモデルサイズ(既定: medium)")
    parser.add_argument("--max-chars-per-line", type=int, default=18, help="1行あたりの最大文字数")
    args = parser.parse_args()

    if not os.path.exists(args.input):
        print(f"エラー: 入力ファイルが見つかりません: {args.input}", file=sys.stderr)
        sys.exit(1)

    try:
        import whisper
    except ImportError:
        print(
            "エラー: openai-whisper がインストールされていません。\n"
            "  pip install openai-whisper\n"
            "を実行してから再度試してください。",
            file=sys.stderr,
        )
        sys.exit(1)

    os.makedirs(args.output_dir, exist_ok=True)

    print(f"Whisperモデル({args.model})を読み込み中...")
    model = whisper.load_model(args.model)

    print("文字起こし中... (音声の長さによっては数分かかります)")
    result = model.transcribe(args.input, language=args.language)
    segments = result.get("segments", [])

    captions = []
    for seg in segments:
        lines = wrap_text(seg["text"], args.max_chars_per_line)
        if not lines:
            continue
        captions.append(
            {
                "start": seg["start"],
                "end": seg["end"],
                "text": "\n".join(lines),
            }
        )

    json_path = os.path.join(args.output_dir, "captions.json")
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(captions, f, ensure_ascii=False, indent=2)

    srt_path = os.path.join(args.output_dir, "captions.srt")
    with open(srt_path, "w", encoding="utf-8") as f:
        for i, cap in enumerate(captions, start=1):
            f.write(f"{i}\n")
            f.write(f"{format_srt_time(cap['start'])} --> {format_srt_time(cap['end'])}\n")
            f.write(f"{cap['text']}\n\n")

    total_duration = captions[-1]["end"] if captions else 0.0
    print(f"完了: {len(captions)}件のテロップを生成しました(動画の長さ約{total_duration:.1f}秒)")
    print(f"  JSON: {json_path}")
    print(f"  SRT : {srt_path}")


if __name__ == "__main__":
    main()
