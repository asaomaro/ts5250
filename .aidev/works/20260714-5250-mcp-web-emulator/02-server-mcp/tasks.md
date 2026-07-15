# タスク: 02-server-mcp

- [x] T1: core 追補 — SysReq/Attn（ヘッダフラグ AID・HDR_FLAG 値修正=decisions D1）、SAVE/RESTORE SCREEN
      コマンド＋全 opcode でデータ適用、`waitForScreen(opts)`（until マッチャ・現在画面即時判定・タイムアウト）、
      `fetchJobInfo(refresh?)`（**コマンドライン DSPJOB 方式**=decisions D2・ヘッダ走査で番号/ユーザー/ジョブ名抽出→
      F3 復帰・キャッシュ・実行中ブロック）。ユニット＋リプレイ fixture。実機で全動作確認済み
- [x] T2: server scaffold — 依存追加（@modelcontextprotocol/sdk・hono・@hono/node-server・@hono/mcp・
      @hono/zod-validator・zod）、最新安定版を確認して固定、tsconfig references（core 参照）、vitest（依存: T1）
- [x] T3: SessionManager — `Map<sessionId, entry>`（UUID v4）、上限（既定 8）、アイドルタイムアウト（30 分無操作で
      切断）、readOnly フラグ、readOnly ゲート（set_fields/signon/run_steps と PageUp/Down 以外の AID を
      READ_ONLY_SESSION 拒否）。ユニット（依存: T2）
- [x] T4: profiles — profiles.json 読込・zod スキーマ検証・passwordEnv 解決、API 露出用サニタイズ
      （name/host のみ・認証情報を返さない）。ユニット（依存: T2）
- [x] T5: signon モジュール — 画面フィールド検出ベースのサインオン（最初の非 hidden=user、最初の hidden=
      password→Enter。明示座標指定対応）。open_session{profile} は connect 時 RFC 4777 自動サインオン（D3）を使う
      ため、本モジュールはフォールバック位置づけ。ユニット（依存: T3, T4）
- [x] T6: format/screenText — ScreenSnapshot→MCP テキスト形式（行番号付きグリッド＋フィールド一覧・SO/SI 桁維持）
      ＋include（grid/fields）/rows 絞り込み。ユニット（依存: T2）
- [x] T7: audit — 構造化 stderr ログ（操作種別・sessionId・フィールド座標のみ・結果・所要時間。値は出さない）。
      MCP/WS 共通ミドルウェア。ユニット（値非出力を検証）（依存: T2）
- [x] T8: MCP ツール（前半 6）— open_session（profile/直接接続・readOnly・D3 自動サインオン）・signon・
      close_session・list_sessions・get_screen・wait_screen。zod 入力＋outputSchema・text+structuredContent
      （依存: T3, T4, T5, T6）
- [x] T9: MCP ツール（後半 4）— set_fields・send_key・run_steps（最大 20 ステップ・expect 検証・中断）・
      get_job_info。エラー→MCP isError 変換の共通ヘルパ（core ErrorCode 使用）（依存: T8）
- [x] T10: MCP サーバー組み立て＋stdio — McpServer 生成・全 10 ツール登録・StdioServerTransport 起動・
      audit 結線。stdout 汚染なしを確認（依存: T9, T7）
- [x] T11: Hono app＋Streamable HTTP＋CLI — serve-static（プレースホルダ）・GET /healthz・GET /api/version・
      GET /api/profiles・POST /mcp（@hono/mcp StreamableHTTPTransport）、CLI（--stdio / --http [port] /
      --profiles <path>）、@as400web/core log 統合。ユニット（REST）（依存: T10）
- [x] T12: MCP E2E（実機）— インプロセス MCP クライアント（stdio）で open_session(profile)→get_screen（メニュー
      確認）→send_key（コマンド/F キー）→更新画面。受け入れ基準の MCP 系 3 項目を検証【実機・PUB400】（依存: T10）
- [x] T13: server 仕上げ — index.ts エクスポート整理、bin エントリ（package.json bin）、profiles.json サンプル、
      server README（起動方法・MCP ツール一覧・stdio/HTTP）（依存: T11）
