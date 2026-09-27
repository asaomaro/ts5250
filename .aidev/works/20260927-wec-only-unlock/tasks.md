# タスク: READ の無い WRITE ERROR CODE

## 実装方針
design のとおり。

## 作業順序と依存関係
下の `依存:` に従う。

## リスク / 留意点
- READ が出ていないのに ready になる状態が新しく生まれる（AID は溜める）

## テスト方針
- 単体・実機・変異

## タスク
- [x] T1: `errorCodeWritten`・施錠を解く・`readOutstanding`・`deferredAid`
      対象: `packages/tn5250/src/protocol/wtd-applier.ts`・`packages/tn5250/src/session/session.ts` / 根拠: research A1・A2
      依存: なし
      AC: AC1
- [x] T2: 単体テスト・DSM のモード・プローブ・検証スクリプト・README
      対象: `packages/tn5250/test/wec-only-unlock.test.ts`・`scripts/host-src/dscmd.c`・`scripts/acs-probe/wec-only-unlock.txt`・`scripts/verify-wec-only-unlock.mjs`・`scripts/README.md`
      依存: T1
      AC: AC1, AC2, AC3
