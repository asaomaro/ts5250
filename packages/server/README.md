# @as400web/server

`@as400web/core` の 5250 セッションを **MCP サーバー**（stdio + Streamable HTTP）と
**Web API**（REST。WebSocket は subtask 03）として公開する。

## 起動

```sh
# stdio（MCP クライアントから起動される想定。stdout は MCP 専用・ログは stderr）
node dist/main.js --stdio --profiles profiles.json

# HTTP（Streamable HTTP MCP ＋ REST ＋ 静的配信）
node dist/main.js --http 3400 --profiles profiles.json
```

CLI: `--stdio` / `--http [port]`（既定 3400）/ `--profiles <path>`。

## MCP ツール（12）

| ツール | 概要 |
|---|---|
| `open_session` | セッションを開く。`{profile}` で設定プロファイルから自動サインオン、または host 等を直接指定。`readOnly` で閲覧専用 |
| `signon` | 接続済みセッションへ画面フィールド方式でサインオン（フォールバック。PUB400 は open_session の自動サインオンを推奨） |
| `close_session` / `list_sessions` | 切断 / 一覧 |
| `get_screen` | 現在画面（text＋structuredContent）。`include`(grid/fields)・`rows` で絞り込み |
| `wait_screen` | ホスト発の更新を待つ（`until` で特定テキスト出現待ち。ポーリング撲滅） |
| `set_fields` | フィールドにローカル入力（ホスト送信なし） |
| `send_key` | fields 反映＋カーソル設定＋AID 送信 → 更新画面。`key` は Enter/F1–F24/PageUp/Down 等 |
| `run_steps` | 複数ステップを順次実行（`expect` 不一致で中断） |
| `get_job_info` | 対話ジョブの識別子（番号/ユーザー/ジョブ名）。コマンド行に DSPJOB→F3 復帰（decisions D2） |
| `select_gui_choice` | 拡張 5250 GUI 選択フィールドの選択状態を更新（ローカル）。単一=排他 / 複数=トグル |
| `submit_gui_selection` | GUI 選択フィールドを確定送信（選択肢の AID があればそれを、無ければ key/Enter を Read 応答） |

- 画面応答は **text**（行番号付きグリッド＋フィールド一覧＋GUI セクション）と **structuredContent**
  （cursor/keyboardLocked/fields/systemMessage/gui）を併記。グリッドは token 節約のため text 側のみ。
- 拡張 5250 GUI（ウィンドウ/選択フィールド/スクロールバー）は接続時 `enhanced: true`（profile も可）で広告し、
  `snapshot.gui` として露出（既定 OFF。decisions 06/D2）。
- **認証情報はツール引数に取らない**（D13）。サインオンは profile 経由（自動）か signon ツール（画面入力）。
- 全操作は stderr に**監査ログ**（操作種別・sessionId・フィールド座標のみ・結果。値は出さない。D14）。

## REST

- `GET /healthz` … `{ status, sessions }`
- `GET /api/version` … `{ name, version }`
- `GET /api/profiles` … プロファイル一覧（**認証情報なし**。name/host/接続パラメータと autoSignon のみ）
- `POST /mcp` … MCP Streamable HTTP
- `GET /` … web-ui 静的配信（subtask 03 でプレースホルダを置換）

## profiles.json

`profiles.json.example` を参照。パスワードは `signon.passwordEnv`（環境変数名）で渡し、ファイルに平文を書かない。

```jsonc
{ "profiles": [ { "name": "pub400", "host": "pub400.com", "port": 23, "ccsid": 37,
  "deviceName": "WEBEMU01", "signon": { "user": "YOUR_USER", "passwordEnv": "PUB400_PASSWORD" } } ] }
```

## 検証

- ユニット: `npm test -w @as400web/server`
- 実機 E2E（MCP クライアント → PUB400）: `node --env-file=.env scripts/verify-mcp.mjs`
