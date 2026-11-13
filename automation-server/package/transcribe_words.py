#!/usr/bin/env python3
"""
transcribe_words.py
Whisperで単語ごとの時刻つき文字起こしをする(テロップの表示タイミングと言い間違い検出の基準)。

使い方:
  python3 transcribe_words.py --input cut_audio.wav --out words.json [--model medium] [--prompt 台本の冒頭]
出力: [{"i":0,"w":"あなた","start":0.12,"end":0.40}, ...]
"""

import argparse
import json
import sys


def transcribe(path, model_name="medium", initial_prompt=None, log=print):
    import whisper
    log(f"  Whisper({model_name})を読み込み中…")
    model = whisper.load_model(model_name)
    log("  単語ごとの時刻つきで文字起こし中…(長い動画は数分〜十数分かかります)")
    kw = {"language": "ja", "word_timestamps": True, "condition_on_previous_text": False}
    if initial_prompt:
        kw["initial_prompt"] = initial_prompt[:300]
    res = model.transcribe(path, **kw)
    words = []
    for seg in res.get("segments", []):
        for w in seg.get("words", []):
            t = w["word"].strip()
            if not t:
                continue
            words.append({"i": len(words), "w": t, "start": round(float(w["start"]), 3), "end": round(float(w["end"]), 3)})
    return words


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--model", default="medium")
    ap.add_argument("--prompt", default=None)
    a = ap.parse_args()
    words = transcribe(a.input, a.model, a.prompt)
    json.dump(words, open(a.out, "w", encoding="utf-8"), ensure_ascii=False, indent=0)
    print(f"{len(words)}語を書き出しました: {a.out}")


if __name__ == "__main__":
    sys.exit(main())
