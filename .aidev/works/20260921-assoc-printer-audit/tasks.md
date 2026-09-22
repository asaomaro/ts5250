# タスク: 関連付けの監査

## テスト方針
- server の ws テスト（`setAuditSink` で記録を拾う）。mutation。

## タスク
- [x] T1: `prepareAssociation` を分け、監査を出す。
      対象: `packages/server/src/ws-handler.ts` `prepareAssociation` / 根拠: research A1
      依存: なし
      AC: AC1, AC2, AC3, AC4
- [x] T2: 各経路のテストと mutation。
      対象: `packages/server/test/ws-associated-printer.test.ts`
      依存: T1
      AC: AC1, AC2, AC3, AC4
