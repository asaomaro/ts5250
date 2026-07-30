# タスク: 結果を返さない SQL 文を実行する

- [x] T1: `core/src/hostserver/db/statement-kind.ts`（新規）— `isNonQueryStatement()`
- [x] T2: `core/test/sql-statement-kind.test.ts` — spec の境界表（依存: T1）
- [x] T3: `core/src/hostserver/db/execute.ts`（新規）— `executeStatement()`（依存: T1）
- [x] T4: `core/test/sql-execute.test.ts` — 要求の形と SQLCODE の扱い（依存: T3）
- [x] T5: `core/src/index.ts` で公開（依存: T3）
- [x] T6: `server/src/host-sql.ts` — 振り分けと応答（`kind: "execute"`）／`?` を断る（依存: T5）
- [x] T7: `server/test/host-sql-execute.test.ts`（依存: T6）
- [x] T8: `web-ui/src/components/SqlPane.vue` — 行数 / 完了 / 警告の表示（依存: T6）
- [x] T9: `web-ui/test/sql-pane-execute.test.ts`（依存: T8）
- [x] T10: 実機 E2E `scripts/verify-browser-sql-exec.mjs`（依存: T9）
- [x] T11: 空振り検証（依存: T10）
- [x] T12: 文書 — backlog に結論、`scripts/README.md` に 2 本、`decisions.md`（依存: T11）
