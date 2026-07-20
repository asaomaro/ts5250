# タスク

- [x] **T1** `retrieveLob`（要求 0x1816・応答 0x3810/0x380F）＋分割受信
- [x] **T2** `LobPlaceholder` → `LobValue`（value / unavailable を持つ）
- [x] **T3** `query` の `lob` オプション（既定は取らない・maxBytes 既定 64KB）
- [x] **T4** 単体テスト（応答の解析・分割の結合・上限・未知 CCSID）
- [x] **T5** **実機で 64KB 超の LOB** を作って分割受信を確認
- [x] **T6** MCP `host_sql` と `/api/host/sql` にオプション（上限 1MB）
- [x] **T7** Web UI のチェックボックス＋表示、CSV
- [x] **T8** README に**ロケーターは接続に紐づく**ことを明記
- [x] **T9** `tsc -b` / lint / 全テスト / web-ui ビルド / 実ブラウザ確認
