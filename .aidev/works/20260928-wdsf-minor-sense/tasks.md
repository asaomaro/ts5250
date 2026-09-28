# タスク: WDSF のマイナー構造体の否定応答

## 実装方針
選択欄 → 窓 → 罫線の順に、原典を読みながら実装し、そのつど単体テストで境界値を固定する。

## 作業順序と依存関係
下の `依存:` に従う。

## リスク / 留意点
- バイトオフセットは decompiled Java の `n` の increment を 1 行ずつ手で追う。読み違いは既存テストでは検出できない
  （新しいコードなので既存テストは通って当然）ため、境界値のテストを先に落として確かめてから直す

## テスト方針
- `wtd-order-sense.test.ts` に単体を追加。既存の WDSF テスト一式（grid/gui/session/border）と変異検査で回帰を確認

## タスク
- [x] T1: `SENSE` に `WDSF_GRID_MINOR_TYPE`・`WDSF_GRID_REPEAT_SPACING` を足す
      対象: `packages/tn5250/src/protocol/wtd-applier.ts` `SENSE`
      依存: なし
      AC: AC1
- [x] T2: `selectionMinorSense`（0x50）を実装し `wdsfShapeSense` の case 0x50 から呼ぶ
      対象: `packages/tn5250/src/protocol/wtd-applier.ts` / 根拠: research F1, F2
      依存: T1
      AC: AC1
- [x] T3: `windowMinorSense`（0x51）を実装し case 0x51 から呼ぶ
      対象: 同上 / 根拠: research F3
      依存: T1
      AC: AC1
- [x] T4: `gridMinorSense`（0x60）を実装し case 0x60 から呼ぶ
      対象: 同上 / 根拠: research F4, F5
      依存: T1
      AC: AC1
- [x] T5: 単体テスト（境界値・スクロール・バー付き選択欄・メニューバー・罫線の型/位置/反復/間隔・複数マイナーの歩き）
      対象: `packages/tn5250/test/wtd-order-sense.test.ts`（追加）
      依存: T2, T3, T4
      AC: AC1
- [x] T6: 既存の WDSF 系テストの回帰確認（fixture の修正含む）
      対象: `packages/tn5250/test/wdsf-applier-grid-lines.test.ts` ほか既存 WDSF テスト
      依存: T4
      AC: AC1
