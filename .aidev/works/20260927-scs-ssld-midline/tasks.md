# タスク: SSLD

## 実装方針
design のとおり。

## 作業順序と依存関係
下の `依存:` に従う。

## リスク / 留意点
- 実機では未実測（research F4）

## テスト方針
- 単体・変異

## タスク
- [x] T1: `skip2b` の SSLD と改行、単体テスト
      対象: `packages/scs/src/scs.ts`・`packages/scs/test/scs.test.ts` / 根拠: research A1
      依存: なし
      AC: AC1
