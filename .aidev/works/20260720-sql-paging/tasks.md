# タスク

- [x] **T1** `result-set-store.ts`（保持・アイドル 60 秒・1 ユーザー 4 つ・所有）＋単体テスト
- [x] **T2** `/api/host/sql` が `resultSetId` / `hasMore` を返す（`maxRows` 指定時は従来どおり）
- [x] **T3** `/api/host/sql/:id/next` と `DELETE`
- [x] **T4** サーバー終了時に全結果セットを閉じる
- [x] **T5** **実機で stream を 1000 件超**読み進める（ブロック境界）
- [x] **T6** UI: 件数ドロップダウン（50/200/500/1000）
- [x] **T7** UI: End / PageDown / スクロールで読み足し（二重要求を塞ぐ）
- [x] **T8** UI: 「これ以上ありません」「セッション切れ」「CSV（表示中の N 件）」
- [x] **T9** server / web-ui テスト
- [x] **T10** 実ブラウザ（キーボード・スクロール・期限切れ）
- [x] **T11** `tsc -b` / lint / 全テスト / MCP の回帰
