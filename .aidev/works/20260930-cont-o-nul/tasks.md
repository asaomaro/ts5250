# タスク: 継続した O 欄の空きと空白

## 実装方針
測る（貼り付け・打鍵を ALT で）→ 鎖の値に空きを持たせる → core → 実機。

## 作業順序と依存関係
下の `依存:` に従う。

## リスク / 留意点
- 鎖の値の表し方が変わる（U+0000）。既存の鎖のテストの期待を空きに合わせて直す
- 継続でない O 欄・J・E は変えない

## テスト方針
- 単体（セル・送信）・コンポーネント・変異・実機（C01〜C12・P1〜P8）

## タスク
- [x] T1: ACS の貼り付けと打鍵を ALT で測る（DSM の CONTOP・プローブの paste 命令）
      対象: `scripts/host-src/dscmd.c` `scripts/acs-probe/AcsProbe.java` `scripts/acs-probe/cont-o-paste.txt`
      依存: なし
      AC: AC4
- [x] T2: web-ui の鎖の値の空き（セル・詰め直し・ScreenGrid）
      対象: `packages/web-ui/src/composables/oFieldCells.ts` `oChainCells.ts` `fieldValidate.ts` `packages/web-ui/src/components/ScreenGrid.vue`
      依存: なし
      AC: AC1, AC3
- [x] T3: core の値の置き方
      対象: `packages/tn5250/src/screen/buffer.ts` `setFieldCells` `setFieldValue`
      依存: なし
      AC: AC3
- [x] T4: テスト・変異・実機のブラウザ検証
      対象: `packages/web-ui/test/o-chain-cells.test.ts` `o-chain-edit.test.ts` `o-chain-erase.test.ts`（新規）`packages/tn5250/test/o-chain-send.test.ts` `scripts/verify-browser-cont-o.mjs` `scripts/verify-browser-cont-o-paste.mjs`（新規）
      依存: T2, T3
      AC: AC1, AC2, AC3, AC4
