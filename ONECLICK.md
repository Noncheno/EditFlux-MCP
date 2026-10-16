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
   - **ジャンプカットを実行**: アクティブシーケンスを複製し、`<元の名前> - Jump Cuts` 上で無音区間を検出・削除
   - **テロップを生成**: アクティブシーケンスを複製し、`<元の名前> - Telop` 上でWhisper文字起こし → キャプショントラックとして自動挿入
   - **メディアを選んで挿入**: 選んだファイルをインポートし、再生ヘッド位置の最上段ビデオトラックに挿入

## 既知の制約

- どちらのワークフローも **オーディオトラック0 (A1)** のみを解析対象にする（BGM/SE トラックは対象外）
- テロップはPremiereの既定キャプションスタイルで作成される。文字色・縁取り・位置は手動調整が必要（`files/CLAUDE.md`記載の既定テロップスタイルは未反映）
- 「NGシーン」の意味的な判定、強調ワードごとの装飾、BGM尺合わせ、トークテーマ自動生成は未実装（[ROADMAP.md](./ROADMAP.md)参照）
- 自動化サーバーはPremiere起動時に自動起動しない。パネルの「自動化サーバーを起動」を毎回押す必要がある
