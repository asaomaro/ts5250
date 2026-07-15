# 計画: 02-server-mcp — MCP サーバー＋server 基盤

親: 20260714-5250-mcp-web-emulator（scope は親 plan.md の境界表で凍結済み。ここでは分解のみ・再分割なし）
依存: 01-core-sbcs（review 承認済み）

## 実装方針

- 下から積む: core 追補（SysReq/waitForScreen/fetchJobInfo）→ server 基盤（SessionManager/profiles/signon/
  audit/format）→ MCP ツール 10 個 → stdio 起動 → Hono app（Streamable HTTP/REST/静的配信/CLI）→ 実機 E2E。
- **サインオンは D3（RFC 4777 自動サインオン）を第一とする**: `open_session {profile}` は core の
  `connect({user, password})`（NEW-ENVIRON 自動サインオン）で行う。独立した `signon` ツール（接続済みセッションへの
  画面フィールド入力）はフォールバックとして実装するが、PUB400 では機能しない既知の制約（decisions.md D3）を明記する。
- WebSocket ハンドラは subtask 03 の scope（ここでは実装しない）。serve-static は 03 の web-ui ビルド前のため
  プレースホルダ応答でよい。

## MCP ツール（10 個・spec 準拠）

open_session / signon / close_session / list_sessions / get_screen / wait_screen /
set_fields / send_key / run_steps / get_job_info。
全ツール zod 入力スキーマ＋outputSchema、画面を返すものは text（screenText 形式）＋structuredContent（ScreenSnapshot 派生）。

## リスク / 留意点

- **fetchJobInfo は SysReq を要する**: core は現状 SysReq/Attn を未対応（sendAid が throw）。T1 で
  ヘッダフラグ AID（SRQ ビット）送信を core に追加する（親 plan の「core 追補」に含まれる範囲）。
- **DSPJOB 画面のレイアウト差**: fetchJobInfo はラベル走査で吸収。PUB400 実機で DSPJOB を確認して合わせる。
  想定外画面では JOB_INFO_UNAVAILABLE で F3/F12 復帰。
- **stdout 汚染禁止（D9）**: stdio MCP モードでは stdout に MCP プロトコル以外を出さない。全ログは core の
  log（pino/stderr）経由。MCP SDK/Hono の初期化ログにも注意。
- **MCP SDK/Hono のバージョン**: research 準拠（@modelcontextprotocol/sdk v1.x 安定版、@hono/mcp）。
  T2 で最新安定版を確認して固定する。
- 実機 E2E は PUB400 の接続制限に配慮し直列・少接続。資格情報は profiles.json の passwordEnv 経由。

## テスト方針（この subtask の範囲・protocol 2.8）

- ユニット: SessionManager（上限・アイドル・readOnly ゲート）、profiles（zod・passwordEnv・サニタイズ）、
  signon（フィールド検出）、format/screenText（include/rows 絞り込み・桁維持）、audit（値を出さない）、
  core 追補（waitForScreen・fetchJobInfo をリプレイ trace で）。
- 契約: MCP ツールの入出力スキーマ（zod/outputSchema）検証、エラー→MCP isError 変換。
- 実機 E2E: インプロセス MCP クライアント（stdio）で open_session(profile)→get_screen（メニュー）→
  send_key（F キー/コマンド）→更新画面。**受け入れ基準の MCP 系 3 項目**をここで検証。
- Web・DBCS・TLS・27x132・複数同時セッションは 03/04・親統合 test に委ねる（ここでは検証しない）。
