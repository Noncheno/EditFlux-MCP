#!/usr/bin/env python3
"""
gemini.py
Gemini API の呼び出し(JSON応答・音声添付・再試行・予備モデル切り替え)。

APIキーは環境変数 GEMINI_API_KEY、無ければ EditFlux の automation-server/.env から読む。
混雑(429/500/503)は待って再試行し、それでもダメなら予備モデルに切り替える。
1回あたり最大 TIMEOUT 秒で打ち切る(応答が返らないまま止まり続けないように)。
"""

import base64
import hashlib
import json
import os
import time
import urllib.error
import urllib.request

TIMEOUT = 300
CACHE_DIR = os.path.join(os.environ.get("PREMIERE_PACKAGE_CACHE",
                                        os.path.expanduser("~/Library/Caches/premiere-xml-package")), "gemini")
ENV_CANDIDATES = [
    os.path.expanduser("~/Projects/EditFlux/automation-server/.env"),
    os.path.expanduser("~/Library/Application Support/Adobe/CEP/extensions/EditFluxOneClick/automation-server/.env"),
]


def _load_env():
    for p in ENV_CANDIDATES:
        if not os.path.exists(p):
            continue
        for line in open(p, encoding="utf-8"):
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            k, v = k.strip(), v.strip().strip("\"'")
            if k and k not in os.environ:
                os.environ[k] = v


def models():
    _load_env()
    # 軽量版(flash-lite)は使わない: 動画①で試したところ、Whisperの誤りを写すだけで、テロップの単語範囲もずれた
    ms = [os.environ.get("GEMINI_MODEL", "gemini-3.8-flash"), os.environ.get("GEMINI_FALLBACK_MODEL", "gemini-3.5-flash")]
    return [m for i, m in enumerate(ms) if m and m not in ms[:i]]


def api_key():
    _load_env()
    k = os.environ.get("GEMINI_API_KEY")
    if not k:
        raise RuntimeError("GEMINI_API_KEY が見つかりません(環境変数か EditFlux の .env に設定してください)")
    return k


_EXHAUSTED = set()


def _quota_info(raw):
    """429の中身から、1日の上限か1分の上限か、待つべき秒数を読む"""
    try:
        err = json.loads(raw).get("error", {})
    except Exception:
        return "minute", None
    kind, delay = "minute", None
    for d in err.get("details", []):
        for v in d.get("violations", []) or []:
            if "PerDay" in (v.get("quotaId") or ""):
                kind = "day"
        if str(d.get("@type", "")).endswith("RetryInfo"):
            try:
                delay = float(str(d.get("retryDelay", "")).rstrip("s"))
            except ValueError:
                pass
    return kind, delay


def generate_json(prompt, schema=None, audio_path=None, audio_mime="audio/mp3", temperature=0.2, log=print):
    """プロンプト(+音声)を送り、JSONとして解析した応答を返す"""
    parts = []
    if audio_path:
        with open(audio_path, "rb") as f:
            parts.append({"inline_data": {"mime_type": audio_mime, "data": base64.b64encode(f.read()).decode()}})
    parts.append({"text": prompt})
    cfg = {"responseMimeType": "application/json", "temperature": temperature}
    if schema:
        cfg["responseSchema"] = schema
    body = json.dumps({"contents": [{"parts": parts}], "generationConfig": cfg}).encode()
    # 同じ依頼の応答は保存して使い回す(途中で止まっても、再実行では続きから処理できる。無料枠の節約にもなる)
    cache_path = os.path.join(CACHE_DIR, hashlib.md5(body).hexdigest() + ".json")
    if os.path.exists(cache_path):
        try:
            with open(cache_path, encoding="utf-8") as f:
                c = json.load(f)
            log("  (前回のGeminiの応答を再利用)")
            return c["res"], c["model"]
        except Exception:
            pass
    key = api_key()
    last = ""
    for model in models():
        if model in _EXHAUSTED:
            continue
        waits = [0, 5, 15, 30, 60, 90]
        attempt = 0
        while attempt < len(waits):
            if waits[attempt]:
                time.sleep(waits[attempt])
            attempt += 1
            req = urllib.request.Request(
                f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
                data=body, headers={"Content-Type": "application/json", "x-goog-api-key": key})
            try:
                with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
                    data = json.loads(r.read())
            except urllib.error.HTTPError as e:
                raw = e.read()
                last = f"{model}: HTTP {e.code} {raw[:200]!r}"
                if e.code == 429:
                    kind, delay = _quota_info(raw)
                    if kind == "day":
                        # 1日の上限(無料枠)に達したモデルは、この実行中はもう使わない
                        _EXHAUSTED.add(model)
                        log(f"  {model} は今日の利用上限に達しました。予備モデルに切り替えます")
                        break
                    wait = min(65, delay or 20)
                    log(f"  Geminiの1分あたりの上限のため {wait:.0f}秒待って再試行します")
                    time.sleep(wait)
                    continue
                if e.code in (500, 503):
                    log(f"  Gemini混雑のため再試行します({model} HTTP {e.code})")
                    continue
                break  # それ以外のエラーは予備モデルへ
            except Exception as e:  # タイムアウト等 → 予備モデルへ
                last = f"{model}: {e}"
                log(f"  Geminiが応答しないため予備モデルに切り替えます({e})")
                break
            try:
                text = data["candidates"][0]["content"]["parts"][0]["text"]
                res = json.loads(text)
                try:
                    os.makedirs(CACHE_DIR, exist_ok=True)
                    with open(cache_path, "w", encoding="utf-8") as f:
                        json.dump({"res": res, "model": model}, f, ensure_ascii=False)
                except OSError:
                    pass
                return res, model
            except Exception as e:
                last = f"{model}: 応答の解析に失敗 {e}"
                continue
    if all(m in _EXHAUSTED for m in models()):
        raise RuntimeError("Geminiの無料枠(モデルごとに1日20回)を今日は使い切りました。"
                           "明日もう一度実行するか、Google AI Studioで有料プランにしてください"
                           "(文字起こしの結果は保存されているので、再実行は速く終わります)")
    raise RuntimeError(f"Gemini APIの呼び出しに失敗しました: {last}")
