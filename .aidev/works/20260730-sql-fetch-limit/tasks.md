# タスク: 取得する行数を実際に抑える（早期打ち切り）

- [x] T1: `core/src/hostserver/db/query.ts` に `queryLimited()` を追加（`query` は触らない）
- [x] T2: `core/test/sql-query-limited.test.ts` — 境界・往復回数・ブロック値・LOB（依存: T1）
- [x] T3: `core/src/index.ts` で公開（依存: T1）
- [x] T4: MCP `host_sql` を載せ替え、**説明文を実態に合わせる**（依存: T3）
- [x] T5: `/api/host/sql` の単発経路を載せ替え（コメントの腐りも直す）（依存: T3）
- [x] T6: `server/test/host-sql-limit.test.ts`（依存: T4・T5）
- [x] T7: 実機で MCP 経路を 1 度通して往復回数を確認（依存: T6）
- [x] T8: 空振り検証（依存: T7）
- [x] T9: 文書 — backlog 2 項目に結論、`scripts/README.md`、`decisions.md`（依存: T8）
