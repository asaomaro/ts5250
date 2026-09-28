# タスク: 符号付き数値の欄の MF・自己点検で符号の桁を数えない

## 実装方針
`checkedBody` を足し、2 つの判定から使う。

## 作業順序と依存関係
下の `依存:` に従う。

## リスク / 留意点
- 値の末尾の空白が落ちている場合

## テスト方針
- 単体 `packages/web-ui/test/mandatory-sign-digit.test.ts`・既存の web-ui 全件

## タスク
- [x] T1: `checkedBody` と `mandatoryFillViolated`・`selfCheckViolated` の変更、単体テスト
      対象: `packages/web-ui/src/composables/mandatoryCheck.ts:45` `mandatoryFillViolated`・`:55` `selfCheckViolated`・`isFull`
      依存: なし
      AC: AC1, AC2, AC3
