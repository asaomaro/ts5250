# タスク: WDSF 0x54

## 実装方針
parser → applier → buffer → 実機。

## 作業順序と依存関係
下の `依存:` に従う。

## リスク / 留意点
- 既存テストが「0x54 は読み飛ばす」を固定している（書き換える）

## テスト方針
- 単体 `wdsf-gui.test.ts`・実機 `scripts/verify-write-data.mjs`

## タスク
- [x] T1: parser・applier・buffer
      対象: `packages/tn5250/src/protocol/wdsf-parser.ts`・`wtd-applier.ts`・`screen/buffer.ts` / 根拠: research A1
      依存: なし
      AC: AC1, AC2, AC3, AC4
- [x] T2: 実機の検証（実行は test 工程）
      対象: `scripts/verify-write-data.mjs`（新規）
      依存: T1
      AC: AC1, AC2, AC3
