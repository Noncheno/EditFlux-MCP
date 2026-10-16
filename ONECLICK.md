# EditFlux ワンクリック編集パネル

このリポジトリ独自の追加機能。Premiere Pro内に常駐する日本語ボタンUIから、
ジャンプカット・メディア挿入をワンクリックで実行できる。

**テロップ生成ボタンは一旦パネルから削除した**(Whisperの精度・改行の安定性、
Premiereネイティブキャプションの自動読み取りのいずれも実用レベルに達しなかったため。
詳細は本ファイル末尾の「テロップ生成(現在は無効化)」を参照)。当面は
Premiereの「文字起こし」機能を直接使う運用とする。サーバー側のコード
(`workflowTelop`・`workflowRefineNativeCaptions`等)は削除せずそのまま残してあるので、
将来再開したくなったらボタンを復活させるだけでよい。

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
   - **メディアを選んで挿入**: 選んだファイルをインポートし、再生ヘッド位置の最上段ビデオトラックに挿入
   - **インサート動画を自動挿入**(「⑤挟み込み」タブ): 音声の内容に合うB-roll素材を自動で挟み込む(下記参照)
   - テロップは、Premiereの「文字起こし」機能を直接使う(下記参照)

### インサート動画の自動挿入(挟み込み)

話している内容に合うB-roll素材を自動検出して、新規ビデオトラックに挟み込む機能(`workflowInsertBroll`)。

**前提**: 素材フォルダが「悩む」「資格」「50代リストラ系」のようにテーマ別のフォルダに分かれていること(個々のファイル名は適当でよい。フォルダ名がそのままタグとして使われる)。既定の参照先は `~/Downloads/広告動画作成素材/広告素材`(`automation-server/.env` の `EDITFLUX_BROLL_ROOT` で変更可)。

**判定方法は2段階**:
1. `automation-server/.env` に `GEMINI_API_KEY`(Google AI Studio、<https://aistudio.google.com/apikey> で無料取得)を設定していれば、Gemini APIに全セリフとフォルダ候補一覧を渡し、1回のAPI呼び出しでどのセリフにどのフォルダが合うか判定してもらう(`geminiMatchTakes`)。`.env.example` をコピーして使う
2. キーが無い、またはAPI呼び出しに失敗した場合は、キーワード辞書方式(`BROLL_KEYWORDS`)にフォールバックする。無料・オフラインで動くが、辞書に無い言い回しは拾えない

**挿入ルール**(ユーザーの編集ガイドライン通り):
- 1テイク = 「文の頭から次の文の頭まで」(Whisperのセグメント開始〜次のセグメント開始)
- 7秒を超えるテイクは2本の素材に分割する
- 挿入する合計尺は動画全体の30〜40%(目安35%)。マッチ度の高いテイクから優先的に採用する
- 同じフォルダを連続で使う場合はファイルが重複しないよう選ぶ(ファイルが複数あれば)

新規ビデオトラックを1本追加し、そこに配置する(既存トラックは変更しない)。実行後のログで、使われた判定方法(Gemini/キーワード辞書)・カバー率・使用フォルダ一覧が確認できる。

### ジャンプカットのプリセット

「検出する無音の長さ」(これより短い無音は無視する)と「残す長さ」(カット後もその無音から末尾側に残す長さ。呼吸やタメを完全に消さないため)の組み合わせ。`automation-server/server.js` の `JUMP_CUT_PRESETS` で定義。

| プリセット | 検出する無音の長さ | 残す長さ | 狙い |
|---|---|---|---|
| インタビュー・対談動画 | 0.5秒以上 | 0.2秒 | 自然な呼吸やタメを消しすぎない |
| プレゼンテーション・解説動画 | 0.3秒以上 | 0.1秒 | テンポを最優先 |
| Vlog・日常系動画 | 1.0秒以上 | 0.3秒 | ゆったりした空気感を残す |

APIを直接叩く場合は `{ "preset": "interview" }` のように指定するか、`minDurationSec` / `residualSec` を個別に上書きできる。

### テロップ生成(現在は無効化)

パネルの「テロップを生成」「Premiereの文字起こしを自動読み取り」ボタンは削除し、
当面はPremiereの「文字起こし」機能を直接使う運用に切り替えた。試した内容と結論:

1. **Whisper文字起こし + 自動整形**(`workflowTelop`): 脱字・誤認識が解消しきれず、
   1行文字数の自動折り返しもPremiere側の再折り返し(3行問題)と完全には噛み合わなかった
   (漢字加重`charWeight`、`Sequence.CAPTION_FORMAT_SUBTITLE`明示など複数の修正を入れたが、
   根本解決には至らなかった)
2. **シナリオ(台本)欄による脱字対策**(`alignScriptToSegments`/`parseScenarioCards`/
   `distributeCardsAcrossSegments`): Whisperのタイミングだけ借りて正しいテキストを
   流し込む仕組み。考え方自体は有効だが、Whisper自体の精度問題が解決しないと根本対策にならない
3. **Premiereネイティブキャプションの自動読み取り**(`workflowRefineNativeCaptions`/
   `scriptReadNativeCaptions`): Premiereにキャプションを読む公式APIが無く、
   非公式な方法を試したが**この環境では読み取りに失敗することを確認済み**
4. **キャプショントラックの重複**: テロップ生成を複数回実行すると、古いトラックを
   消さずに毎回追加してしまい、画面上で古い生成結果と新しい生成結果が重なって表示される
   問題があった。削除を試みる処理(`scriptImportAndCreateCaptionTrack`内)は入れたが、
   削除の公式APIが無いため確実性がない

上記の理由から、ユーザー判断で**Premiereの「文字起こし」を手動で使う運用に戻した**(2026-10-16)。
サーバー側のコードは削除せず残してあるので、将来また自動化したくなった場合は
`index.html`/`panel.js`にボタンを復活させるだけで再開できる。テロップのスタイル一覧
(`EditFlux Telop`フォルダの.mogrtサムネイル表示、`Window > Extensions`パネル下部)は
引き続き使える — Premiereの「キャプションをグラフィックに変換」でスタイルを当てる際の
参考ギャラリーとして機能する。

## 既知の制約

- ジャンプカットは**アクティブシーケンスを直接編集する**(非破壊複製はしない)。実行前にプロジェクトを保存しておくことを推奨。元に戻す場合はCmd+Z
- ジャンプカットは **オーディオトラック0 (A1)** のみを解析対象にする（BGM/SE トラックは対象外）
- 「NGシーン」の意味的な判定、単語単位の強調、BGM尺合わせ、トークテーマ自動生成は未実装（[ROADMAP.md](./ROADMAP.md)参照）
- 自動化サーバーはPremiere起動時に自動起動しない。パネルの「自動化サーバーを起動」を毎回押す必要がある
