# タスク: 罫線の寿命

## 実装方針
core の穴 → 0x5F・0x61 → 画面の描画 → 実機。

## 作業順序と依存関係
下の `依存:` に従う。

## リスク / 留意点
- 既存のテストが「0x5F・0x61 で全部消える」を固定している（ACS と違う——書き換える）

## テスト方針
- 単体 `wdsf-applier-grid-lines.test.ts`・`screen-grid-gridlines.test.ts`・実機

## タスク
- [x] T1: 窓の穴（`GuiGridLine.holes`・`addWindow`）
      対象: `packages/tn5250/src/screen/buffer.ts` `addWindow`・`packages/tn5250/src/screen/types.ts` `GuiGridLine` / 根拠: research A1
      依存: なし
      AC: AC1
- [x] T2: 0x5F は罫線を残す・0x61 は矩形の穴
      対象: `packages/tn5250/src/protocol/wdsf-parser.ts`・`wtd-applier.ts`・`buffer.ts` / 根拠: research A2
      依存: T1
      AC: AC2, AC3
- [x] T3: 画面の線分を穴で削る
      対象: `packages/web-ui/src/components/ScreenGrid.vue` `gridSegments` / 根拠: research A3
      依存: T1
      AC: AC1, AC3
- [x] T4: 実機のブラウザの検証（実行は test 工程）
      対象: `scripts/verify-browser-grid-lifetime.mjs`（新規）
      依存: T2, T3
      AC: AC4
