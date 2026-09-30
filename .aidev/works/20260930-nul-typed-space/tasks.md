# タスク: 継続でない O 欄の空き（NUL）と空白

## 実装方針
測る（SPACETY）→ セルの詰め物を空きに → 値の側（web-ui）→ core → 必須埋め → 実機。

## 作業順序と依存関係
下の `依存:` に従う。

## リスク / 留意点
- 全 O 欄（日本語機の多くの入力欄）の値の表し方が変わる。既存の実機スクリプト（o-field 系）で回帰を確かめる
- 既存のテストの期待は「空きも空白」で書かれているものがある（意味を確かめて空きへ直す）

## テスト方針
- 単体（セル・ScreenGrid・core の送信）・変異・実機のブラウザ（SPACETY の O 欄）と既存の実機スクリプトの回帰

## タスク
- [x] T1: ACS の打った末尾の空白を欄の種類ごとに測る（DSM の SPACETY・新しいプローブ）
      対象: `scripts/host-src/dscmd.c` `scripts/acs-probe/space-typed.txt`
      依存: なし
      AC: AC1
- [x] T2: セルの詰め物と値の側（O 欄の空き）
      対象: `packages/web-ui/src/composables/oFieldCells.ts` `packages/web-ui/src/components/ScreenGrid.vue` `trimPad` `padDbcs` `logicalFromCells`
      依存: T1
      AC: AC1, AC2
- [x] T3: core と必須埋め
      対象: `packages/tn5250/src/screen/buffer.ts` `setFieldCells` `packages/web-ui/src/composables/mandatoryCheck.ts` `isFull`
      依存: T2
      AC: AC1, AC3
- [x] T4: テスト・変異・実機のブラウザ検証（回帰を含む）
      対象: `packages/web-ui/test/o-field-nul.test.ts`（新規）`packages/tn5250/test/o-field-send.test.ts`（新規）既存テストの期待 `scripts/verify-browser-space-typed.mjs`（新規）
      依存: T3
      AC: AC1, AC2, AC3, AC4
