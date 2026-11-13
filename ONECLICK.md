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
   - **ジャンプカットを実行**: **アクティブシーケンスを直接編集**して無音区間を検出・削除する(複製しない)。喋り終わりから1秒残し、息継ぎと無音をカットする。元に戻したい場合はPremiereの取り消し(Cmd+Z)を使う
   - **メディアを選んで挿入**: 選んだファイルをインポートし、再生ヘッド位置の最上段ビデオトラックに挿入
   - **インサート動画を自動挿入**(「⑤挟み込み」タブ): 音声の内容に合うB-roll素材を自動で挟み込む(下記参照)
   - テロップは、Premiereの「文字起こし」機能を直接使う(下記参照)

### インサート動画の自動挿入(挟み込み)

話している内容に合うB-roll素材を自動検出して、新規ビデオトラックに挟み込む機能(`workflowInsertBroll`)。

**前提**: 素材フォルダが「悩む」「資格」「50代リストラ系」のようにテーマ別のフォルダに分かれていること(個々のファイル名は適当でよい。フォルダ名がそのままタグとして使われる)。既定の参照先は `~/Downloads/広告動画作成素材/広告素材`(`automation-server/.env` の `EDITFLUX_BROLL_ROOT` で変更可)。

**判定方法は2段階**:
1. `automation-server/.env` に `GEMINI_API_KEY`(Google AI Studio、<https://aistudio.google.com/apikey> で無料取得)を設定していれば、Gemini APIに全セリフとフォルダ候補一覧を渡し、1回のAPI呼び出しでどのセリフにどのフォルダが合うか判定してもらう(`geminiMatchTakes`)。`.env.example` をコピーして使う
2. キーが無い、またはAPI呼び出しに失敗した場合は、キーワード辞書方式(`BROLL_KEYWORDS`)にフォールバックする。無料・オフラインで動くが、辞書に無い言い回しは拾えない

**精度のための工夫**:
- 文字起こしはWhisper **medium**(smallより日本語の誤認識が少ない。`.env`の`EDITFLUX_BROLL_WHISPER_MODEL`で変更可)
- Geminiには候補フォルダ名にキーワード辞書の意味を添えて渡す。結果はセリフ番号で対応付けるので、Geminiが途中の1件を飛ばしても以降の判定がずれない
- Geminiの確信度が0.6未満の判定は挿入しない(`EDITFLUX_BROLL_MIN_SCORE`で変更可)
- Geminiが混雑(503/429)や無応答のときは、待って再試行し、それでもダメなら予備モデル`gemini-3.5-flash`に切り替える(`GEMINI_FALLBACK_MODEL`で変更可。1回あたり最大2分で打ち切る)

**挿入ルール**:
- 1テイク = 「文の頭から次の文の頭まで」(Whisperのセグメント開始〜次のセグメント開始)。2秒未満の短いセグメントは次とつなげて1テイクにする
- 7秒を超えるテイクは、各片が7秒以下になるよう均等に分割する
- 同じフォルダを連続で使う場合はファイルが重複しないよう選ぶ(ファイルが複数あれば)
- **「マッチした箇所を全部挿入する」チェック(既定でON)**: マッチした箇所を全て挿入する(`fullCoverage: true`)。チェックを外すと、元のユーザー編集ガイドライン通り動画全体の30〜40%(目安35%、マッチ度の高いテイクから優先採用)に絞る(`buildBrollPlan`の`fullCoverage`オプション)

新規ビデオトラックを1本追加し、そこに配置する(既存トラックは変更しない)。インポートしたファイルは、プロジェクトパネルの**「素材」ビン**にまとめて入る(無ければ自動作成する)。**映像のみ挿入し、素材に音声が付いていてもリンクされた音声クリップは自動で削除する**(ナレーション音声と重ならないようにするため)。実行後のログで、使われた判定方法(Gemini/キーワード辞書)・カバー率・使用フォルダ一覧が確認できる。

### ジャンプカットの動作

パネルで2種類から選ぶ(ユーザー指定、2026-11-13)。どちらも**次の喋り出し前の息継ぎと無音はカット**し、カット後は**言葉の始まりから直接つなぐ**(無音を入れない)。

| プリセット | 喋り終わりに残す長さ | カットされる間 | 狙い |
|---|---|---|---|
| 間を残す(`natural`、既定) | 1秒 | 1.2秒以上 | 間を大切にする |
| テンポ重視(`tempo`) | 0.15秒 | 0.35秒以上 | 間を詰めてテンポよく |

(カットされる間 = 残す長さ + 最小カット0.2秒。旧プリセット名`interview`/`vlog`は`natural`、`presentation`は`tempo`として扱う)

- 無音の判定は、音声を20ms単位の平均音量(RMS)に変換して行う。ffmpegの`silencedetect`は波形の瞬間的なピークで判定するため、平均では静かな息継ぎでもピークが基準を超えて「音あり」になり、息継ぎが残ってしまうので使わない
- 無音のしきい値は**素材ごとに自動で決める**(静かな側10パーセンタイル=環境ノイズ、大きい側90パーセンタイル=声とし、ノイズ+60%の位置。-50〜-25dBの範囲)。静かな素材では 無音≒-80dB・息継ぎ≒-50dB・声≒-20dB なので約-44dBになり、息継ぎは無音側、小さな語尾は音あり側に判定される
- 0.12秒未満の短い音(リップノイズ・クリック音)に挟まれた無音は1つの無音として扱う。ただし喋り終わりから0.3秒以内に続く短い音は「〜です」の「す」のような語尾とみなして残す(`extendSilenceStartsPastSoftEndings`)
- カット位置のタイムコードはPremiere自身のフォーマッタ(`Time.getFormatted`)で作るので、29.97/23.976fpsのシーケンスでも後半でずれない

設定は `automation-server/server.js` の `JUMP_CUT_PRESETS`。APIを直接叩く場合は `tailSec`(喋り終わりに残す秒数)/ `breathSec`(喋り出し前に残す秒数)/ `minDurationSec` / `thresholdDb`(固定しきい値)を個別に上書きできる。

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
