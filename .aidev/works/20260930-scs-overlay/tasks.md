# タスク: SCS の重ね打ち・罫線・半分の幅

## 実装方針
原典（JPS）を読む → 復号 → 描く 3 か所 → テストと変異。

## 作業順序と依存関係
下の `依存:` に従う。

## リスク / 留意点
- 実機のホストがこれらを出すかは未確認（原典の読みと合成の試験で固定）
- `LogicalPage` は多くの経路を通るので、無いときは `decor` を持たない（従来の形を保つ）

## テスト方針
- 復号（合成の SCS）・描く 3 か所・変異

## タスク
- [x] T1: JPS の原典を読む（重ね打ち・DGL・SFSS・字幅）
      対象: `packages/scs/src/scs.ts`（参照コメント）
      依存: なし
      AC: AC1, AC2, AC3
- [x] T2: 復号（`decor`・重ね打ち・半分の幅・DGL・SCD）
      対象: `packages/scs/src/scs.ts` `put` `putWide` `skip2b` `flushPage`
      依存: T1
      AC: AC1, AC2, AC3
- [x] T3: 描く 3 か所（配布 HTML・画面・PDF）
      対象: `packages/scs/src/spool-html.ts` `packages/scs/src/report-line.ts` `packages/web-ui/src/components/ReportText.vue` `packages/server/src/pdf.ts`
      依存: T2
      AC: AC4
- [x] T4: テストと変異
      対象: `packages/scs/test/scs-overlay.test.ts`（新規）`packages/scs/test/spool-html.test.ts` `packages/scs/test/scs.test.ts` `packages/web-ui/test/report-text-shift-marks.test.ts` `packages/server/test/pdf.test.ts`
      依存: T3
      AC: AC1, AC2, AC3, AC4
