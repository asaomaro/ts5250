# タスク: WDSF の構造体ごとの否定応答

## 実装方針
検査の関数 → 実機。

## 作業順序と依存関係
下の `依存:` に従う。

## リスク / 留意点
- 既存テストが崩れた長さ（0x5F の LL 5・0x55 の LL 4）を使っている（直す）

## テスト方針
- 単体 `wtd-order-sense.test.ts`・実機 `scripts/verify-wdsf-negative.mjs`

## タスク
- [x] T1: `wdsfShapeSense` と `SENSE` の追加
      対象: `packages/tn5250/src/protocol/wtd-applier.ts` `applyWdsf` / 根拠: research A1
      依存: なし
      AC: AC1
- [x] T2: 実機の検証（実行は test 工程）
      対象: `scripts/verify-wdsf-negative.mjs`（新規）
      依存: T1
      AC: AC2
