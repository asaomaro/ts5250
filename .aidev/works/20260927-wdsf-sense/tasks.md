# タスク: WDSF の頭の検査

## 実装方針
下の `依存:` に従う。

## テスト方針
- 単体・変異・実機（`scripts/verify-wtd-order-sense.mjs` の WDSF 3 モード・通常の画面の一巡）

## タスク
- [x] T1: WDSF の頭の検査
      対象: `packages/tn5250/src/protocol/wtd-applier.ts` / 根拠: research A1
      依存: なし
      AC: AC1, AC2
- [x] T2: DSM・検証・片付け
      対象: `scripts/host-src/dscmd.c`・`scripts/verify-wtd-order-sense.mjs`
      依存: T1
      AC: AC1, AC2
