# as400-web-emulator

IBM i（AS400）の **5250 画面**を、**MCP サーバー**（AI エージェント用）と **Web エミュレーター**（ブラウザ／デスクトップ）の
2 つのフロントから操作できるツール群です。TN5250 プロトコルを **純 TypeScript** で実装しており、外部の 5250
ライブラリや IBM ACS の jar には依存しません。両フロントは共通の 5250 コア（`packages/core`）を使うため、
画面の見え方・振る舞いが定義上一致します。

- **AI から操作**: MCP ツール経由で LLM が 5250 アプリを自動操作（サインオン・画面取得・キー送信・ジョブ情報 …）。
- **人が操作**: ブラウザ／Electron の忠実な 5250 エミュレーターで、ACS に近い操作感。
- **検証実績**: [PUB400.com](https://pub400.com)（IBM i 7.5）に対する実機 E2E で動作確認済み。

---

## ✨ 特徴

**プロトコル / 接続**
- RFC 4777 **NEW-ENVIRON 自動サインオン**（バインド時認証。PUB400 で確認済み）
- telnet ネゴシエーション（BINARY / EOR / TERMINAL-TYPE / NEW-ENVIRON）、**TLS**（既定ポート 992・証明書検証既定 ON）
- **画面サイズ**を接続ごとに 24x80 / 27x132 から選択（端末タイプで申告し、ホストが対応画面を
  CLEAR UNIT ALTERNATE でワイド送信。SBCS / DBCS とも PUB400 実機で確認済み → [画面サイズ](#画面サイズ24x80--27x132)）

**文字・画面**
- EBCDIC ⇔ Unicode 変換（ICU `.ucm` 由来テーブル生成）。**DBCS（日本語）** は EBCDIC_STATEFUL（SO/SI）で
  **桁位置を厳密維持**（SO/SI・属性桁を 1 セルとして保持）
- カラー・下線・リバース等の属性を再現。フィールド属性はフィールド長で境界付け（ACS 準拠）
- 5250 QUERY 応答、**拡張 5250 GUI**（Create Window / Define Selection Field / Scroll Bar = WDSF 0x15）

**Web エミュレーター（ACS 準拠の操作感）**
- 忠実なフィールド編集（**5250 上書き既定 / Insert トグル / 5250 流バックスペース**）、**フィールド型別の入力検証**
  （数値・SBCS(A)・DBCS-open(O)・DBCS-pure(J)）、欄が最大桁まで埋まると**次の入力欄へ自動送り**（ACS 挙動）
- **画面全体の自由カーソル**（入力欄外も含む任意セルにカーソル配置。矢印で 1 セル移動）
- **タブ / 矢印**でのフィールド移動（上下は桁を保ち真下へ）、**Ctrl+矢印でカーソル頭出し**（前後の語頭 / 同列の非空白）、
  **マウスホイールでページ送り**（PageUp/Down）
- **DBCS 欄のライブ列ビュー編集**: SO/SI・全角 2 バイトを含む**桁数（バイト予算）で判定**し、SO/SI を桁として表示。
  コピー / カット時は **SO/SI を除いた純データ**をクリップボードへ（送信も同様）
- **行またぎ（折返し）フィールドの編集**: 1 行に収まらない欄（コマンド行 = 153 桁など）を行ごとの入力欄に割りつつ、
  値・カーソル・バイト予算は 1 つの論理欄として扱う（SBCS / DBCS とも。桁割りは ACS と一致）
- **矩形（ブロック）選択**（マウスドラッグ / キーボード Shift+矢印・Home/End、入力欄内外を問わず）→ **複数行コピー**、
  **複数行ペースト**（クリップボードの改行を保持し、開始桁を起点に下方向の連続入力欄へ分配）
- 拡張 5250 GUI をラジオ / チェック / プッシュボタン / ウィンドウ枠 / スクロールバーとして描画・操作
- 画面テキストの **URL / メールをリンク化**、通常 / ダークテーマ、**ペイン分割（D&D）＋キーボード移動（Alt+矢印）**、
  **タブ（D&D 並び替え / 合流・Alt+PageUp/Down 切替）**、操作ログ
- 通信中の**入力プロテクト**＋0.5 秒しきい値の**ローディング表示**、画面サイズ切替（24x80⇔27x132）への自動スケール
- 表示トグル: SO/SI を `{ }`、半角カナ / 英小文字、リンク化 ON/OFF、編集可能なキーバインド

**MCP サーバー**
- stdio ＋ Streamable HTTP、**12 ツール**（サインオン〜画面取得〜キー送信〜ジョブ情報〜GUI 選択）
- 画面は **テキスト（LLM 可読）＋ structuredContent** で返却（桁維持・GUI 構造体・fields/cursor）
- 認証情報はツール引数に取らず**プロファイル経由**、監査ログは値を出さない（マスク）

---

## 🏗 構成（npm workspaces モノレポ）

| パッケージ | 役割 |
|---|---|
| `packages/core` | TN5250 プロトコルコア（telnet・5250 データストリーム・画面モデル・EBCDIC⇔Unicode・trace/replay） |
| `packages/server` | MCP サーバー（stdio + Streamable HTTP）・WebSocket/REST・web-ui 静的配信 |
| `packages/web-ui` | ブラウザ 5250 エミュレーター（Vue 3 + Vite） |
| `tools/gen-tables` | ICU `.ucm` → TS 変換テーブル生成（ビルド時ツール） |

共通コアを server / web-ui が消費する縦貫構成。ESM、Node ≥ 20。

---

## 🚀 クイックスタート

**前提**: Node.js ≥ 20、npm。IBM i 接続先（例: 無料の [PUB400.com](https://pub400.com) アカウント）。

### Web エミュレーター（ブラウザ）

```sh
./start.sh            # Linux / macOS / WSL（初回は依存インストール＋ビルドを自動実行）
start.bat             # Windows
```

起動後、ブラウザで **http://localhost:3400** を開きます。

```sh
./start.sh --port 8080     # ポート変更
./start.sh --build         # 強制再ビルド
./start.sh --profiles path.json
```

### デスクトップ版（Electron）

```sh
./electron.sh         # Linux / macOS / WSL
electron.bat          # Windows
```

既存の Hono サーバーを内部で起動し、`BrowserWindow` で Web UI を表示します。
インストーラ生成は `cd electron && npm install && npm run dist`（要 GUI / 対象 OS）。

---

## 🖥 Web エミュレーターの使い方

1. **接続**: 接続画面で「サーバー」プロファイル（`profiles.local.json` 由来）または「ブラウザ」保存接続をクリック。
   「＋ 新規接続」からホスト直指定で追加でき、**編集 / 削除**、**自動サインオン(RFC 4777) の ON/OFF ＋資格情報**を設定可能。
2. **操作**:
   - 入力欄に直接タイプ（5250 上書き既定、Insert で挿入トグル）。満杯で次欄へ自動送り
   - **Tab / Shift+Tab** で欄移動、**矢印**でカーソル移動（上下は桁を保って真下へ／入力欄外も自由移動）
   - **Ctrl+矢印** でカーソル頭出し（←→=前後の語頭、↑↓=同じ列の非空白セル）
   - **Enter / F1–F24**（Shift+F… で F13–F24）、**PageUp/Down**（マウスホイールでも）
   - **範囲選択**: マウスドラッグ、または **Shift+矢印 / Shift+Home/End** で画面を**矩形選択** → **Ctrl+C** で複数行コピー。
     複数行テキストを **Ctrl+V** すると、貼り付け開始桁を起点に下方向の連続入力欄へ分配
   - **タブ**: Alt+PageUp/Down で切替、D&D で並び替え・別ペインへ合流。**ペイン**: Alt+矢印で移動、端 D&D で分割
   - ローカル編集キー（Field Exit / Erase EOF / Erase Input）、キーバインドは編集可能
3. **表示**: 通常 / ダーク切替、SO/SI `{ }` 表示、半角カナ表示、リンク化 ON/OFF。ペイン分割・タブで複数セッション。

> 💡 画面サインオン・自動サインオン（RFC 4777）のどちらでも接続できます（PUB400 実機で確認）。
> 画面サインオンで **`CPF1120`（ユーザー不存在/パスワード不一致）** が出るのに自動サインオンは通る、という
> 場合はコードページの食い違いを疑ってください（→ [ホストコードページ](#ホストコードページccsidとホスト側の変換)）。

---

## 🤖 MCP サーバーの使い方

### 起動

```sh
npm run build
npm run build -w @as400web/web-ui                # Web UI を配信する場合のみ

# stdio（MCP クライアントから起動される想定）
node packages/server/dist/main.js --stdio --profiles profiles.local.json

# HTTP（Streamable HTTP + WebSocket + Web UI 配信）
node packages/server/dist/main.js --http 3400 --web-root packages/web-ui/dist --profiles profiles.local.json
```

### MCP クライアント設定例（stdio）

```json
{
  "mcpServers": {
    "as400-5250": {
      "command": "node",
      "args": [
        "/absolute/path/to/as400-web-emulator/packages/server/dist/main.js",
        "--stdio",
        "--profiles",
        "/absolute/path/to/profiles.local.json"
      ],
      "env": { "PUB400_PASSWORD": "your-password" }
    }
  }
}
```

### ツール一覧（12）

| ツール | 概要 |
|---|---|
| `open_session` / `close_session` / `list_sessions` | セッションの開始（プロファイル自動サインオン or host 直指定）／切断／一覧 |
| `signon` | 画面フィールド方式のサインオン（フォールバック） |
| `get_screen` | 現在画面（text＋structuredContent、`include` / `rows` で絞り込み） |
| `wait_screen` | ホスト発の更新待ち（`until` で特定テキスト出現待ち） |
| `set_fields` | フィールドにローカル入力（ホスト送信なし） |
| `send_key` | fields 反映＋カーソル設定＋AID 送信 → 更新画面（Enter / F1–F24 / PageUp/Down 等） |
| `run_steps` | 複数ステップを順次実行（`expect` 不一致で中断） |
| `get_job_info` | 対話ジョブの識別子（番号 / ユーザー / ジョブ名） |
| `select_gui_choice` / `submit_gui_selection` | 拡張 5250 GUI 選択フィールドの選択・確定送信 |

- 画面応答は **text**（行番号付きグリッド＋フィールド一覧＋GUI）と **structuredContent**（cursor/fields/gui …）を併記。
- **認証情報はツール引数に取らない**（プロファイル経由）。監査ログは値を出さない。

---

## ⚙️ 接続プロファイル

`packages/server/profiles.json.example` を `profiles.local.json` としてコピーして編集します
（`*.local.json` は `.gitignore` 済み。パスワードは環境変数で渡す運用を推奨）。

```json
{
  "profiles": [
    {
      "name": "pub400",
      "host": "pub400.com",
      "port": 23,
      "ccsid": 273,
      "deviceName": "WEBEMU01",
      "signon": { "user": "YOUR_USER", "passwordEnv": "PUB400_PASSWORD" }
    }
  ]
}
```

- `signon` を省略すると自動サインオンせず signon 画面に着地します。
- `tls: true`（ポート既定 992）、`ccsid`（930/939/1399 等で DBCS）、`screenSize`（`"24x80"` / `"27x132"`）、
  `enhanced: true`（拡張 5250 GUI 広告）も指定可。

### 画面サイズ（24x80 / 27x132）

`screenSize` は接続時の telnet 端末タイプ交渉に落ちる**申告**です。ブラウザの接続フォームからも選べます。

**どちらで描くかを決めるのは常にホスト側**で、画面ごとに違います。ホストは表示ファイルの `DSPSIZ` に
27x132（`*DS4`）版があり、かつ端末が 27x132 対応のときだけ `CLEAR UNIT ALTERNATE` でワイド画面を送ります。
そのため 27x132 を選んでも、`*DS4` 版を持たない画面（サインオン画面・`MAIN` メニュー・`WRKACTJOB` など）は
**24x80 のまま来ます** — これは異常ではありません。`STRSEU` は `*DS4` を持つので 132 桁で来ます。

端末タイプは接続時にしか申告できないため、**セッション中の動的な切替はできません**（切り替えるには接続し直します）。

申告する端末タイプは次のとおりです。SBCS は RFC 1205 の一覧どおり。DBCS 側は RFC 1205 に無く、IBM の
ドキュメントも 5555 系を一律「24x80 または 27x132」と書くだけでサイズを型番に紐づけていないため
（tn5250 は DBCS 自体が未実装で先例にならない）、**PUB400 実機で総当たりして決めました**。

| | 24x80 | 27x132 |
|---|---|---|
| SBCS | `IBM-3179-2` | `IBM-3477-FC` |
| DBCS | `IBM-5555-G02` | `IBM-5555-C01` |

DBCS でカラーなのはこの 2 つだけです（`IBM-5555-B01` / `G01` はモノクロで、掴むと青・桃・黄が落ちて 4 色になります。
`A01` / `D01` / `E01` / `F01` はホストが交渉を拒否します＝telnet の名前ではありません）。
`G02` は定義上「グラフィックス表示」ですが、グラフィックス非対応は Query Reply で別途申告しています。
この対応表は `scripts/verify-screen-size.mjs` が実機で検証します。

### ホストコードページ（`ccsid`）とホスト側の変換

`ccsid` はホストのそれと一致させる必要は**ありません**。接続時に RFC 2877 の
`KBDTYPE` / `CODEPAGE` / `CHARSET` を申告するため、ホストが仮想デバイスをこちらのコードページで作り、
ジョブ CCSID との差を**自動変換**します（37 / 273 / 930 / 939 / 1399 を PUB400 実機で確認）。

この申告が無いと、ホストはシステム既定でデバイスを作るため、EBCDIC の **variant 文字**
（`@` `$` `#` `[` `]` など、コードページごとに位置が変わる文字）が食い違います。英数字は invariant なので
**症状が出ず**、変な文字を含むパスワードだけが通らない、という紛らわしい形で現れます
（PUB400 は `QCCSID=273`。無申告＋`ccsid:37` だと `@`(0x7C) をホストが `§` と読み、signon 画面が
**`CPF1120`（ユーザー不存在/パスワード不一致）**になっていた）。

ホストの CCSID は `DSPSYSVAL SYSVAL(QCCSID)` で確認できます。なお **RFC 4777 自動サインオンは
この影響を受けません**（パスワードを telnet NEW-ENVIRON で送るため EBCDIC 変換を経ない）。
「自動サインオンは通るのに画面からは通らない」なら、デバイス属性の申告漏れやコードページ周りを疑ってください。

---

## 🧪 開発・テスト

```sh
npm install
npm run build        # tsc -b（全パッケージ）
npm run build -w @as400web/web-ui   # Web UI（vue-tsc + vite）
npm test             # vitest（全パッケージ）
npm run lint         # eslint
npm run gen:tables   # .ucm から変換テーブルを再生成（.ucm 更新時のみ）
```

- **trace-first**: PUB400 実機トレース（JSONL）を `packages/core/test/fixtures/` に採取し、パーサ・画面モデルは
  リプレイでオフライン回帰。実機 E2E スクリプトは `scripts/`（要 `.env` の `PUB400_USER` / `PUB400_PASSWORD`）。
- **ログは stderr のみ**（stdio MCP の stdout 汚染禁止）。`console.*` は lint 禁止、`@as400web/core` の `log`（pino/stderr）を使う。
- 秘密情報（`.env` / `*.local.json`）はコミットしない（`.gitignore` 済み）。

---

## 📋 既知の制約

- DBCS 欄が行末で折り返すとき、全角 1 文字が行末と次行頭にまたがることがある（5250 は 1 画面桁 =
  1 バイトのため実際に起こる）。ACS はこのグリフを左右に割って描画するが、Web は 1 行 = 1 個の
  `<input>` で組むため半分に割れない。またぐ全角は前の行の末尾に置いて欄幅でクリップし（左半分が
  行末に出る）、次行の 1 桁目は空白にしている。**桁割り・送信データ・欄の容量は ACS と一致**し、
  行末のグリフの右半分が見えない点だけが異なる。
- 画面サイズ（24x80 / 27x132）は接続ごとの設定で、**セッション中に切り替えられない**。5250 では端末タイプを
  接続時の telnet 交渉でしか申告できないため（→ [画面サイズ](#画面サイズ24x80--27x132)）。ACS は
  ショートカットキーでの切替を持つ。

---

## 📎 補足

- **ワイヤ仕様（他言語移植用）**: [`docs/PROTOCOL.md`](docs/PROTOCOL.md) — telnet ネゴ／RFC 4777 自動サインオン／
  GDS レコード／WTD オーダー／属性・FFW/FCW／Query Reply／WDSF GUI／Read 応答のバイトレベル仕様。
  移植版の検証は `packages/core/test/fixtures/*.jsonl`（言語非依存 trace）のリプレイで行える。
- 設計資料: `.aidev/works/20260714-5250-mcp-web-emulator/`（requirement / research / spec / design / plan /
  walkthrough / decisions / retro）。開発規約は [`AGENTS.md`](AGENTS.md)。
- 検証環境: [PUB400.com](https://pub400.com)（要アカウント。週次再起動・接続数制限あり）。
- 参考: RFC 1205 / RFC 4777 / SC30-3533、GNU tn5250（挙動・バイト仕様の参照のみ。GPL コードは非移植）。
