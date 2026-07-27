# タスク: DBCS 欄の埋め込み属性を編集・送信で失わない

- [x] **T1**: core の round-trip テストを書く（落ちることを確認）
  - `packages/core/test/` に追加。DBCS 欄（構造なし）で
    値取得 → 制御コード桁に触れない編集 → `setFieldValue` → **属性セルが残る**
  - 送信バイト列に属性バイト 0x28 が含まれる
  - 属性より前を 1 文字削ると属性の桁が 1 つ左へ動く
  - **DBCS 構造つき欄の送信バイトが変わらない**（R1 の固定。修正前後で同じ）
- [x] **T2**: core を直す（依存: T1）
  - `fieldValue` の `dbcs ? " " :` を外す（spec D1）
  - `snapshot` の属性セルに `rawByte: cell.byte`（spec D2）
  - `browser.ts` から `attrSentinel` を輸出（spec D3 のため）
- [x] **T3**: web-ui のテストを書く（落ちること を確認）
  - `dbcsByteLength(センチネル)` が 1 であること
- [x] **T4**: web-ui を直す（依存: T3）
  - `logicalFromCells` が属性をセンチネルで残す（spec D3）。誤ったコメントも直す
  - `dbcsByteLength` がセンチネルを 1 バイトで数える（spec D4）
- [x] **T5**: 通し確認（依存: T2, T4）
  - `npm run build` / `npm test` / `npm run lint` / `npm run build -w @as400web/web-ui`
  - T1 / T3 を修正前へ戻して落ちることを再確認
  - `rawByte` の既存利用箇所が属性セルで誤動作しないことを確認（R4）
