# @ts5250/server

端末セッション（`@ts5250/tn5250` / `@ts5250/tn3270` / `@ts5250/vt`）と IBM i ホストサーバー
（`@ts5250/hostserver`）を、**MCP サーバー**（stdio + Streamable HTTP）と **Web API**
（REST + WebSocket）として公開する。web-ui の静的配信と、常駐サービスの管理もここが持つ。

## 起動

```sh
# stdio（MCP クライアントから起動される想定。stdout は MCP 専用・ログは stderr）
node dist/main.js --stdio --profiles profiles.json

# HTTP（Streamable HTTP MCP ＋ REST ＋ WebSocket ＋ 静的配信）
node dist/main.js --http 3400 --profiles profiles.json --web-root ../web-ui/dist
```

主な CLI:

| オプション | 既定 | 意味 |
|---|---|---|
| `--stdio` / `--http [port]` | — / 3400 | トランスポート |
| `--host <addr>` | 認証オフは `127.0.0.1`、オンは全 IF | 待ち受けアドレス |
| `--profiles <path>` | `profiles.json` | サーバー設定。**明示指定したファイルが無ければ起動しない** |
| `--connections <path>` | `connections.json` | 個人設定 |
| `--macros <path>` | `macros.json` | マクロ（`secretEnc` を持つ） |
| `--users <path>` | （なし＝無認証） | 認証を有効化（scrypt・role） |
| `--web-root <dir>` | （なし） | web-ui の `dist` を静的配信 |
| `--auto-secret-key` / `--secret-key-file <path>` | — | パスワード暗号化の master key を自動生成 |
| `--hash-password` | — | scrypt ハッシュを出力して終了（`users.json` 作成の補助） |
| `--idle-timeout <分 or never>` | `never` | 無操作で切るまでの既定 |
| `--max-watches <n>` | 4 | 待ち受け（常駐サービス）の同時数 |
| `--dtaq-max-wait <秒>` | 60 | `host_dtaq_receive` の待機上限 |
| `--trace-records` | — | 受信レコードを hex でログへ（障害切り分け専用。**画面の中身が残るので常用しない**） |
| `--cookie-secure` | — | ログイン Cookie に `Secure` を付ける |
| `--ifs-*` | — | IFS の読み書き・zip・アップロード・削除の上限 |

## MCP ツール（48）

**5250 経由（24）** — 画面を操作してテキストを読み取る。

| ツール | 概要 |
|---|---|
| `open_session` / `close_session` / `list_sessions` | セッションの開始（`session` / `system` / host 直指定）／切断／一覧。`readOnly` で閲覧専用 |
| `signon` | 画面フィールド方式のサインオン（フォールバック。`system` 必須） |
| `list_systems` / `list_session_configs` | 接続できるシステム／保存済みセッション設定の一覧。返る `ref` を `system` / `session` へ。**資格情報も信頼設定も返さない** |
| `get_screen` | 現在画面（text＋structuredContent。`include` / `rows` で絞り込み） |
| `get_screen_html` | 現在画面を**エミュレーターの見た目のまま自己完結 HTML**で取得 |
| `start_screen_recording` / `stop_screen_recording` / `get_screen_history_html` | 画面遷移を記録し、前後にたどれる 1 枚の HTML にまとめる（**記録するのは画面と送信キーだけ**） |
| `wait_screen` | ホスト発の更新待ち（`until` で特定テキスト出現待ち。ポーリング撲滅） |
| `set_fields` / `send_key` / `run_steps` | ローカル入力 / AID 送信 / 複数ステップ実行（`expect` 不一致で中断） |
| `get_job_info` | セッションのジョブ識別子。**画面には触れない** |
| `select_gui_choice` / `submit_gui_selection` | 拡張 5250 GUI 選択フィールドの選択・確定送信 |
| `open_printer_session` | TN5250E プリンターセッションを開いて待ち受ける |
| `wait_spool` / `list_spools` / `get_spool` | 受信スプールを等幅テキストで取得（次の 1 件を待つ / 一覧 / 再取得） |
| `get_spool_pdf` / `get_spool_html` | 受信スプールを PDF（base64）／自己完結 HTML で取得 |

**ホストサーバー経由（24）** — `host_` 接頭辞。**装置名もセッションも要らず単発**で叩ける。

| ツール | 概要 |
|---|---|
| `host_sql` | SQL 実行。**更新・DDL は `allowWrite: true` のときだけ**。`maxRows` 既定 200、LOB は既定ロケーターのみ |
| `host_sql_explain` / `host_plan_list` | 実行計画の採取（特権不要）／プランキャッシュ一覧（**`*JOBCTL` 等が要る**。無ければ `available: false`） |
| `host_upload_table` | CSV を表へ**追加**（INSERT のみ） |
| `host_command` | CL コマンドを実行（**非対話のみ**）。`CPF…` の ID・重大度を構造化して返す |
| `host_call_program` / `host_call_service_program` | プログラム / QSYS API ／ `*SRVPGM` の手続きを呼ぶ |
| `host_list_messages` / `host_reply_message` / `host_send_message` / `host_remove_messages` | メッセージ待ち行列の一覧・**照会への応答**・送信・削除 |
| `host_list_spools` / `host_get_spool` | **既存**スプールの検索（pull 型）／中身の取得 |
| `host_read_file` / `host_write_file` | IFS の読み書き（`utf8` / `base64`） |
| `host_list_jobs` / `host_list_objects` / `host_list_users` | ジョブ・オブジェクト・ユーザーの一覧 |
| `host_dtaq_send` / `host_dtaq_receive` | データ待ち行列へ積む／取り出す・覗く（peek） |
| `host_dtaq_create` / `host_dtaq_clear` / `host_dtaq_delete` / `host_dtaq_attributes` | 作成・全消去・削除・属性取得 |

- 画面応答は **text**（行番号付きグリッド＋フィールド一覧＋GUI セクション）と **structuredContent**
  （cursor/keyboardLocked/fields/systemMessage/gui）を併記。グリッドは token 節約のため text 側のみ。
- 参照は接頭辞つきトークン: **`srv:<name>`**（サーバー設定 `profiles.json`）/ **`own:<id>`**（個人設定
  `connections.json`）。`session` を渡せば親システムまで一意に決まるので `system` の併記は不要
  （併記して**食い違えばエラー**）。
- 拡張 5250 GUI（ウィンドウ/選択フィールド/スクロールバー）は接続時 `enhanced: true` で広告し、
  `snapshot.gui` として露出（既定 OFF）。
- **認証情報はツール引数に取らない。** サインオンはシステムの `signon` 経由（自動）か `signon` ツール（画面入力）。
- 全操作は stderr に**監査ログ**（操作種別・sessionId・フィールド座標のみ・結果。値は出さない）。
- **3270 / VT は MCP からは扱えない**（WebSocket 専用）。

## REST

認証が有効なとき `/api/*` `/ws` `/mcp` は Cookie セッションか `Authorization: Bearer <token>` を要求する。

| 系統 | 主なパス |
|---|---|
| 基本 | `GET /healthz` / `GET /api/version` / `GET /` （web-ui 静的配信） |
| 認証 | `POST /api/login` / `POST /api/logout` / `GET /api/me` / `POST /api/me/token` |
| 設定 | `GET POST /api/systems`・`PUT DELETE /api/systems/:ref`（`sessions-config` も同形）。**サーバー設定への書き込みは admin のみ**（body の `source: "server" \| "personal"` で保管場所を選ぶ。既定 personal） |
| セッション | `GET /api/sessions` / `GET /api/spool/:sessionId/:spoolId/pdf` |
| 常駐サービス | `GET /api/printers` / `GET /api/watches`（**一覧と状態は誰でも、パスを含む詳細と操作は admin のみ**） |
| マクロ | `GET POST /api/macros` / `PUT DELETE /api/macros/:id` |
| SQL | `POST /api/host/sql` / `/sql/warm` / `/sql/:id/next` / `DELETE /api/host/sql/:id` / `/sql/explain` / `GET /api/host/plans[/:id]` |
| ホスト機能 | `/api/host/list/:kind`・`/action`・`/messages{,/send,/reply,/remove}`・`/program`・`/service-program`・`/pcml/{parse,call}`・`/command/{template,build,run}`・`/spools`・`/spool/{content,html,pdf}`・`/upload`・`/dtaq/*`・`/ifs/*` |
| HLLAPI | `POST /api/hllapi`（→ [`docs/HLLAPI.md`](../../docs/HLLAPI.md)） |
| 管理 | `/api/admin/users`・`/api/admin/sessions`・`/api/admin/logs`（すべて `requireAdmin`） |
| MCP | `POST /mcp`（Streamable HTTP） |

## WebSocket（`/ws`）

**1 接続 = 1 セッション。** `open` で開き、以後は種別ごとのメッセージで往復する。

- 表示（5250 / 3270）: `key` / `gui-select` / `gui-submit` → `screen` / `key-done` / `jobinfo` /
  `reserved` / `reserve-break`。**表示を変えないキー**（ヘルプ非対応時の F1 など）は画面が返らないので、
  完了は `key-done` で別に通知する。
- VT: `vt-input` / `vt-resize` → `vt-opened`（最初の 1 通だけ全行）/ `vt-frame`（以降は差分）/
  `vt-echo` / `vt-title`。
- プリンター: `printer-start` / `printer-stop` / `printer-service-start` → `printer-opened` /
  `report` / `printer-state` / `printer-output-*` / `printer-warn`。
- 待ち行列の監視: `watch-subscribe` / `watch-start` / `watch-stop` / `watch-resume` / `watch-history`
  → `watch-list` / `watch-entry` / `watch-state` / `watch-history`。
- `open` は MCP と同じ `system` / `session` / `host` を受ける。

## profiles.json

`profiles.json.example` を参照。パスワードは `signon.passwordEnv`（環境変数名）か `signon.passwordEnc`
（AES-256-GCM）で渡し、**平文の `password` は起動時にエラーにする**。ファイルは**システム**（接続先＋
資格情報＋既定 CCSID）と**セッション設定**（種別・端末・装置名・画面サイズ・CCSID 上書き・
プリンター出力・監視対象）の 2 配列を持つ。`session.system` は同一ファイル内の `system.id` を指す。

```jsonc
{
  "systems": [
    { "id": "pub400", "name": "pub400", "host": "pub400.com", "port": 23, "ccsid": 37,
      "signon": { "user": "YOUR_USER", "passwordEnv": "PUB400_PASSWORD" } }
  ],
  "sessions": [
    { "id": "pub400", "name": "pub400", "system": "pub400",
      "sessionType": "display", "deviceName": "WEBEMU01" }
  ]
}
```

`sessionType` は `display` / `printer` / `dtaqwatch` / `msgwatch`。後ろの 3 つは**サーバー起動時から
常駐**できる（`autoStart`）。**種別と設定の整合は parse で強制する**——`dtaqwatch` なのに `dtaqWatch`
が無い、`display` なのに `msgWatch` がある、といった設定は受け取った時点で弾く。
**信頼設定（`printer` / `pcCommand` / `webhook`）はサーバー設定のセッションだけが持てる**
（個人設定のスキーマが `.strict()` で拒否する）。

**旧形式（`{ "profiles": [...] }` / `{ "connections": [...] }`）はそのまま読める。** 読み込み時に自動で
2 階層へ分解されるので手作業の移行は不要。新形式で書き出すのは CRUD からの**明示的な保存操作のときだけ**。

## 検証

- ユニット: `npm test -w @ts5250/server`
- 実機 E2E（MCP クライアント → PUB400）: `node --env-file=.env scripts/verify-mcp.mjs`
