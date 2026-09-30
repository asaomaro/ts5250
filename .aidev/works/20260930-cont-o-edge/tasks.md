# タスク: 継続した O 欄の貼り付け（P3）と単独の SO/SI の Delete

## 実装方針
測る（D1〜D8）→ 鎖の操作に載せる → 配線 → 実機。

## 作業順序と依存関係
下の `依存:` に従う。

## リスク / 留意点
- 貼り付けの経路を継続した O 欄だけ差し替える（P1・P2・P4 は既に一致していたので、実機で回帰を確かめる）

## テスト方針
- 単体（セル・貼り付け・ScreenGrid）・変異・実機のブラウザ（D1〜D8・P1〜P8）

## タスク
- [x] T1: ACS の単独の SO/SI の Delete・Backspace を測る（DSM の CONTOX・新しいプローブ）
      対象: `scripts/acs-probe/cont-o-lone-shift.txt`
      依存: なし
      AC: AC3, AC4
- [x] T2: 鎖の操作（`chainDelete` の warn・`chainPaste`）
      対象: `packages/web-ui/src/composables/oChainCells.ts`
      依存: T1
      AC: AC1, AC3, AC4
- [x] T3: ScreenGrid の配線（貼り付け・反映の共通化・エラーの出し方）
      対象: `packages/web-ui/src/components/ScreenGrid.vue` `oChainApply`
      依存: T2
      AC: AC1, AC2, AC3
- [x] T4: テスト・変異・実機のブラウザ検証
      対象: `packages/web-ui/test/o-chain-cells.test.ts` `o-chain-edit.test.ts` `o-chain-paste.test.ts`（新規）`scripts/verify-browser-cont-o-lone-shift.mjs`（新規）`scripts/verify-browser-cont-o-paste.mjs`
      依存: T3
      AC: AC1, AC2, AC3, AC4
