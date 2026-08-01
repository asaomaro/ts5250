# タスク: LOB 表示まわりの follow-up 3 件

- [x] T1: `packages/hostserver/src/index.ts:48` の型 export に `LobPlaceholder` を足す
      （`DbValue` だけでは意味のある形に絞れないため。spec D1）
- [x] T2: `packages/web-ui/src/csv.ts` — `isLob` の述語を `import type` した `LobPlaceholder` に変え、
      `(value as { value?: unknown }).value` の `as` を外す（依存: T1）
- [x] T3: `csv.ts` の `escapeField` に打ち切りの印を足す（`中身…（以降省略）`。画面と同じ。
      **取れた分は捨てない**。エスケープは印を付けた後の文字列に掛ける。spec D2）（依存: T2）
- [x] T4: `packages/web-ui/src/components/SqlResultTable.vue:76-96` の `lobText` / `lobTitle` から
      `as` を外す。**表示は一切変えない**（spec D4）（依存: T1）
- [x] T5: `packages/web-ui/src/components/SqlPane.vue:8` の未使用 import `isLob` を削除
- [x] T6: `packages/web-ui/test/csv.test.ts` に打ち切りのテストを足す
      （`too-large`＋中身 → `中身…（以降省略）` / 中身がクォートを要する場合も正しく囲む）（依存: T3）
- [x] T7: `npm run build` / `npm run lint` / `npm test`（依存: T1〜T6）
