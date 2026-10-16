# EditFlux ワンクリック編集パネル

このリポジトリ独自の追加機能。Premiere Pro内に常駐する日本語ボタンUIから、
ジャンプカット・テロップ生成・メディア挿入をワンクリックで実行できる。

全体構成・今後の方向性は [ROADMAP.md](./ROADMAP.md) を参照。

## 構成

```
cep-plugin-oneclick/   Premiere内に表示するCEPパネル(ボタンUI、日本語)
automation-server/     ローカルHTTPサーバー。ffmpeg無音検出・Whisper文字起こし・
                       ExtendScript実行(既存のMCP Bridge (CEP)経由)を担当
scripts/               インストールスクリプト
```

アーキテクチャ:

```
[EditFluxOneClickパネル(ボタン)]
        │ fetch (http://127.0.0.1:4747)
        ▼
[automation-server] ── ffmpeg / Whisper(python3)
        │ command-NNN.json / response-NNN.json (ファイルブリッジ)
        ▼
[MCP Bridge (CEP)パネル] ── ExtendScript実行
        ▼
   Premiere Pro
```

既存の `MCP Bridge (CEP)` パネル（`cep-plugin/`、本家 adobe-premiere-pro-mcp 由来）には一切手を入れていない。
そのパネルで「Start Bridge」を押して接続済み状態にしておくことが前提。

## 必要なもの

- Premiere Pro（CSXS 10以降）
- Node.js（`automation-server`の実行に使用）
- Python3 + `pip install openai-whisper`（テロップ生成に使用）
- **ffmpeg**（PATH上にあること。無音検出・Whisperの両方で必須）
  ```
  brew install ffmpeg
  ```

## インストール

```bash
bash scripts/install-oneclick-panel-macos.sh
```

`~/Library/Application Support/Adobe/CEP/extensions/EditFluxOneClick` にパネルと
`automation-server` がコピーされる。Premiere Proを再起動し、
`Window > Extensions > EditFlux ワンクリック編集` を開く。

## 使い方

1. 先に `MCP Bridge (CEP)` パネルで `Start Bridge` を押しておく
2. `EditFlux ワンクリック編集` パネルを開く
3. 「自動化サーバーを起動」を押す（起動済みなら不要。次回Premiere起動時は再度押す必要がある — 現時点では自動起動しない）
4. 緑のドットが両方点灯したらボタンが有効になる
   - **ジャンプカットを実行**: **アクティブシーケンスを直接編集**して無音区間を検出・削除する(複製しない)。動画タイプのプリセットを選んでから実行する。元に戻したい場合はPremiereの取り消し(Cmd+Z)を使う
   - **テロップを生成**: **アクティブシーケンスを直接編集**してWhisper文字起こし → キャプショントラックとして自動挿入(複製しない)
   - **メディアを選んで挿入**: 選んだファイルをインポートし、再生ヘッド位置の最上段ビデオトラックに挿入

### ジャンプカットのプリセット

「検出する無音の長さ」(これより短い無音は無視する)と「残す長さ」(カット後もその無音から末尾側に残す長さ。呼吸やタメを完全に消さないため)の組み合わせ。`automation-server/server.js` の `JUMP_CUT_PRESETS` で定義。

| プリセット | 検出する無音の長さ | 残す長さ | 狙い |
|---|---|---|---|
| インタビュー・対談動画 | 0.5秒以上 | 0.2秒 | 自然な呼吸やタメを消しすぎない |
| プレゼンテーション・解説動画 | 0.3秒以上 | 0.1秒 | テンポを最優先 |
| Vlog・日常系動画 | 1.0秒以上 | 0.3秒 | ゆったりした空気感を残す |

APIを直接叩く場合は `{ "preset": "interview" }` のように指定するか、`minDurationSec` / `residualSec` を個別に上書きできる。

## 既知の制約

- ジャンプカット・テロップはどちらも**アクティブシーケンスを直接編集する**(非破壊複製はしない)。実行前にプロジェクトを保存しておくことを推奨。元に戻す場合はCmd+Z
- どちらのワークフローも **オーディオトラック0 (A1)** のみを解析対象にする（BGM/SE トラックは対象外）
- テロップはPremiereの既定キャプションスタイルで作成される。文字色・縁取り・位置は手動調整が必要（`files/CLAUDE.md`記載の既定テロップスタイルは未反映）
- 「NGシーン」の意味的な判定、強調ワードごとの装飾、BGM尺合わせ、トークテーマ自動生成は未実装（[ROADMAP.md](./ROADMAP.md)参照）
- 自動化サーバーはPremiere起動時に自動起動しない。パネルの「自動化サーバーを起動」を毎回押す必要がある
