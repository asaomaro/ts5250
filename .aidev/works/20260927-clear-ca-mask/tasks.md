# タスク: CLEAR 系と CA キーの申告

## 実装方針
design のとおり。

## 作業順序と依存関係
下の `依存:` に従う。

## リスク / 留意点
- SFLCTL の再描画で CUA が来る画面で、ホストが SOH を送り直さないと CA キーが CF キーになる（ACS と同じ振る舞い）

## テスト方針
- 単体・変異・実機

## タスク
- [x] T1: CUA・CFT で申告を捨てる
      対象: `packages/tn5250/src/screen/buffer.ts` / 根拠: research A1
      依存: なし
      AC: AC1
- [x] T2: 単体テスト・DSM のモード・プローブ・検証スクリプト・README
      対象: `packages/tn5250/test/aid-data-mask.test.ts`・`scripts/host-src/dscmd.c`・`scripts/acs-probe/clear-ca-mask.txt`・`scripts/verify-clear-ca-mask.mjs`・`scripts/README.md`
      依存: T1
      AC: AC1, AC2, AC3
