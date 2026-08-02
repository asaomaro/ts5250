# タスク: SQL 結果表を仮想化し、列幅を文字数から決める

- [x] T1: `composables/tableVirtual.ts` に `displayWidth` / `columnCharWidths` /
      `visibleWindow` を書く（**純粋**。DOM を触らない）
- [x] T2: 単体テスト（幅・窓・境界）（依存: T1）
- [x] T3: `SqlResultTable` の `cellText` を切り出し、**テンプレートと幅計算が同じ関数を使う**（依存: T1）
- [x] T4: 幅を宣言して `table-layout: fixed` へ。溢れは `hidden` ＋ `ellipsis`（依存: T3）
- [x] T5: 実ブラウザで**見え方が変わらないこと**を確認（間引く前）（依存: T4）
- [x] T6: 仮想化——窓・詰め物・行番号・`onActivated` の再計算・読み足しでの幅再計算（依存: T5）
- [x] T7: `scripts/verify-sql-table-virtualize.mjs` で実測（速度・幅・スクロール・読み足し）（依存: T6）
- [x] T8: `scripts/README.md` ＋ `npm run build` / `npm run lint` / `npm test`（依存: T7）
