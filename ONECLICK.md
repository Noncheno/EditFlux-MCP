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
   - **テロップを生成**: **アクティブシーケンスを直接編集**してWhisper文字起こし → グラフィック(MOGRT)として専用トラックに自動配置(複製しない)。フォントプリセットを選んでから実行する
   - **メディアを選んで挿入**: 選んだファイルをインポートし、再生ヘッド位置の最上段ビデオトラックに挿入

### ジャンプカットのプリセット

「検出する無音の長さ」(これより短い無音は無視する)と「残す長さ」(カット後もその無音から末尾側に残す長さ。呼吸やタメを完全に消さないため)の組み合わせ。`automation-server/server.js` の `JUMP_CUT_PRESETS` で定義。

| プリセット | 検出する無音の長さ | 残す長さ | 狙い |
|---|---|---|---|
| インタビュー・対談動画 | 0.5秒以上 | 0.2秒 | 自然な呼吸やタメを消しすぎない |
| プレゼンテーション・解説動画 | 0.3秒以上 | 0.1秒 | テンポを最優先 |
| Vlog・日常系動画 | 1.0秒以上 | 0.3秒 | ゆったりした空気感を残す |

APIを直接叩く場合は `{ "preset": "interview" }` のように指定するか、`minDurationSec` / `residualSec` を個別に上書きできる。

### テロップのフォントプリセット

Premiereには「文字からタイトルを作る」API自体が無いため、.mogrt(モーショングラフィックステンプレート)に文字を流し込む方式でテロップを作る。プリセットは**コード編集不要**で、専用フォルダに.mogrtを保存するだけでパネルのドロップダウンに自動で増える:

```
~/Library/Application Support/Adobe/Common/Motion Graphics Templates/EditFlux Telop/
```

**プリセットを増やす手順**(Premiere上の一度きりの手作業):
1. 文字ツールでシーケンス上に仮の文字を1つ作る(1レイヤーのみ、装飾なし)
2. エッセンシャルグラフィックスパネルの「マイスタイル」から使いたいスタイルを適用
3. パネルのメニューから「モーショングラフィックステンプレートとして書き出し」を選び、保存先を上記の `EditFlux Telop` フォルダにする。ファイル名がそのままパネルの選択肢名になるので、分かりやすい名前で保存する
4. `EditFlux ワンクリック編集` パネルを開き直す(または再度「自動化サーバーを起動」)と、ドロップダウンに増えている

テロップは**1行最大16文字・最大2行(合計32文字)**に収まるよう自動で折り返す。収まらない場合は、文字数に応じて尺を分け合う複数カードに分割する(内容を削らない)。句読点(。、！？)はテロップ本文から自動的に除去する。

配置先は既存の映像トラックを上書きしないよう、実行のたびに新しい映像トラックを一番上に追加してそこに敷き詰める。

## 既知の制約

- ジャンプカット・テロップはどちらも**アクティブシーケンスを直接編集する**(非破壊複製はしない)。実行前にプロジェクトを保存しておくことを推奨。元に戻す場合はCmd+Z
- どちらのワークフローも **オーディオトラック0 (A1)** のみを解析対象にする（BGM/SE トラックは対象外）
- テロップの文字色・フォント・サイズは選んだ.mogrtプリセットの見た目に完全依存する。プリセット自体の見た目を変えたい場合はPremiere側でマイスタイルを作り直して再書き出しする
- 「NGシーン」の意味的な判定、単語単位の強調、BGM尺合わせ、トークテーマ自動生成は未実装（[ROADMAP.md](./ROADMAP.md)参照）
- 自動化サーバーはPremiere起動時に自動起動しない。パネルの「自動化サーバーを起動」を毎回押す必要がある
