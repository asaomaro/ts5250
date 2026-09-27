# タスク: 溜めた AID のカーソル

## 実装方針
design のとおり。

## 作業順序と依存関係
下の `依存:` に従う。

## リスク / 留意点
- 原典の読み（`pending_aid`）と実測が合わない。実測に合わせ、原典との食い違いを記録する

## テスト方針
- 単体・変異・実機

## タスク
- [x] T1: 溜めた AID に押したときのカーソルを持たせ、CC1 の施錠で捨てない
      対象: `packages/tn5250/src/session/session.ts`・`packages/tn5250/test/wec-only-unlock.test.ts` / 根拠: research A1
      依存: なし
      AC: AC1
- [x] T2: DSM のモード（UNLOCKWTD*・WECONLYW）・プローブ・検証スクリプト・README
      対象: `scripts/host-src/dscmd.c`・`scripts/acs-probe/unlocked-wtd-cursor.txt`・`scripts/acs-probe/wec-only-unlock.txt`・`scripts/verify-unlocked-wtd-cursor.mjs`・`scripts/verify-wec-only-unlock.mjs`・`scripts/README.md`
      依存: T1
      AC: AC1, AC2, AC3
