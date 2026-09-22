# タスク: 帳票の SO/SI を ACS と同じ桁で描く

## テスト方針
- 単体（既定・SPCC・長さ・HTML の印）。実採取の帳票の期待値の書き換え。mutation。

## タスク
- [x] T1: SO/SI の桁と SPCC。
      対象: `packages/scs/src/scs.ts`
      依存: なし
      AC: AC1
- [x] T2: 印の位置と記述。
      対象: `packages/scs/src/spool-html.ts`
      依存: T1
      AC: AC2
- [x] T3: テストの書き換え・追加と mutation。
      対象: `packages/scs/test/scs.test.ts` `spool-html.test.ts`
      依存: T1, T2
      AC: AC3
