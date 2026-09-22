# タスク: SCS の空白

## テスト方針
- 単体（`scs.test.ts`）。mutation。実採取 3 件の既存テストが不変。期待値の出典は本物の JPS の記録（R11）。

## タスク
- [x] T1: `put`・`putWide` の変更。
      対象: `packages/scs/src/scs.ts` `put` `putWide` / 根拠: research A1
      依存: なし
      AC: AC1, AC2, AC3
- [x] T2: テストと mutation。
      対象: `packages/scs/test/scs.test.ts`
      依存: T1
      AC: AC1, AC2, AC3, AC4
