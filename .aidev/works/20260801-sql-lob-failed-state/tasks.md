# タスク: LOB の未取得理由に `failed` を足す

- [x] T1: `LobPlaceholder.unavailable` の union に `"failed"` を足し、`fillLobs` の catch が
      `"not-requested"` ではなく `"failed"` を入れるようにする
      （`packages/hostserver/src/db/db-decode.ts:39` / `packages/hostserver/src/db/query.ts:459`）。
      型のコメントに「`failed` は取りに行って失敗した」を、catch 側に
      「`not-requested` に落とすと『左のチェックで取得』と案内してしまう」を残す
- [x] T2: 失敗ログを `log.debug` → `log.warn` に上げる（`packages/hostserver/src/db/query.ts:458`。
      decisions D3。`debug` は既定の sink で消えるため、要求された操作の失敗が黙って落ちていた）
- [x] T3: `fillLobs` を `export` にし、`request` が reject する偽 conn で失敗ケースの回帰テストを足す
      （spec D3。`packages/hostserver/test/` に新規。`unavailable === "failed"` /
      `locator`・`maxSize` の保持 / 同じ行の他セルを巻き込まないこと）（依存: T1）
- [x] T4: `SqlResultTable.vue` の `lobText` / `lobTitle` に `failed` の分岐を足す
      （`(LOB: 取得失敗)` ／「LOB の取得に失敗しました（サーバーのログに理由が出ます）」。
      **値が文字列なら先に返す**既存分岐の後ろに置く）（依存: T1）
- [x] T5: `packages/web-ui/test/sql-pane.test.ts` に、`failed` のセルが `(LOB: 取得失敗)` と表示され
      ツールチップに「左のチェックで取得」を**含まない**ことを固定するテストを足す（依存: T4）
- [x] T6: `packages/web-ui/src/csv.ts` の `escapeField` に `failed` の分岐を足す
      （`(LOB: 取得失敗)`。`not-requested` は `(LOB)` のまま・`too-large` は現状のまま・
      **空欄にしない**）（依存: T1）
- [x] T7: `packages/web-ui/test/csv.test.ts` に LOB の CSV 表現のテストを足す
      （現在 LOB の網羅はゼロ。取得済み / `not-requested` / `failed` の 3 状態）（依存: T6）
- [x] T8: `npm run build` / `npm run lint` / `npm test` を通し、
      `packages/hostserver/src/index.ts` が `fillLobs` を公開面に出していないことを確認する（依存: T1〜T7）
