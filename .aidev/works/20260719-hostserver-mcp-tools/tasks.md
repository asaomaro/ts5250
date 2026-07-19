# タスク

- [x] **T1** `packages/server/src/host-connect.ts` を新規作成。`hostOptsFrom` / `openCommand` /
      `openDb` / `openNetPrint` / `openIfs`。`host-lists.ts:143-156` の `openCommand` を**移設**し、
      `host-lists.ts` は新ファイルを import する（重複を残さない）
- [x] **T2** `mcp-tools.ts` の `errorResult` を拡張し、`SqlError` の `sqlCode`/`sqlState` と
      `CommandError` の `primary` を `structuredContent.error` に載せる（既存挙動は変えない）
- [x] **T3** `host_sql`（SELECT 専用の明記・`maxRows` 上限・`truncated`）
- [x] **T4** `host_command` / `host_call_program`（Base64 パラメータ・出力は要求順の前提を明記）
- [x] **T5** `host_list_spools` / `host_get_spool`（既存 `list_spools` との相互参照を description に）
- [x] **T6** `host_read_file` / `host_write_file`（`deleteFile` は出さない＝D3）
- [x] **T7** `host_list_jobs` / `host_list_objects` / `host_list_users`
- [x] **T8** 単体テスト追加（引数検証・資格情報欠落の `CONFIG_ERROR`・`truncated`・
      スキーマに user/password が無いこと・既存 19 ツールの回帰）
- [x] **T9** 実機（PUB400）で 10 本を実行。**接続の所要時間を実測して記録**（D2 の検証）
- [x] **T10** README / ツール一覧に追記。`decisions.md` に D1〜D4 を転記
