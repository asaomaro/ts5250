# タスク: AS400 5250 MCP サーバー ＋ Web エミュレーター（親トラッキング）

各 subtask の詳細タスクは各 subtask の plan 工程で `<NN>-<subslug>/tasks.md` に分解する。
ここは親レベルの進捗トラッキングのみ（チェックは当該 subtask の review 承認時）。

- [ ] S1: 01-core-sbcs — 通信コア SBCS 縦貫通（scaffold・codec37・telnet・パーサ・画面・セッション・trace 採取）
- [ ] S2: 02-server-mcp — MCP 10 ツール＋server 基盤（profiles/signon/audit/readOnly/healthz、core 追補 waitForScreen/fetchJobInfo）（依存: S1）
- [ ] S3: 03-web — WS ハンドラ＋Web UI 全体（グリッド/ワークスペース/接続画面/ログ/テーマ/keymap）（依存: S2）
- [ ] S4: 04-dbcs-tls-wide — DBCS・TLS・27x132・QUERY・受け入れ基準総点検（依存: S3）
