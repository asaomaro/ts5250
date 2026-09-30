# タスク: 全角 1 桁の空き（WIDE_NUL）

## 実装方針
専用の文字 → 値の側の各所 → テスト・実機。

## 作業順序と依存関係
下の `依存:` に従う。

## リスク / 留意点
- J・G・E の既存テストに「ホストが 4040 で埋めた欄」の前提があり、値の意味が変わる（ホストが書いた 4040 は中身）。意味を確かめて期待を直す

## テスト方針
- 単体・変異・実機（space-typed の J・E の ALT と既存の J・E のスクリプト）

## タスク
- [x] T1: WIDE_NUL と値の詰め物・読み戻し・送る形
      対象: `packages/web-ui/src/composables/fieldValidate.ts` `packages/web-ui/src/components/ScreenGrid.vue` `trimPad` `padDbcs` `logicalFromCells` `jeExplicit`
      依存: なし
      AC: AC1, AC2
- [x] T2: End・余地・貼り付け・表示・必須埋め
      対象: `packages/web-ui/src/components/ScreenGrid.vue` `packages/web-ui/src/composables/mandatoryCheck.ts`
      依存: T1
      AC: AC2, AC3
- [x] T3: テスト・変異・実機
      対象: `packages/web-ui/test/wide-nul.test.ts`（新規）既存テストの期待 `scripts/verify-browser-space-typed.mjs`
      依存: T2
      AC: AC1, AC2, AC3
