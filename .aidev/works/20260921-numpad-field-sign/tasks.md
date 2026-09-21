# タスク: テンキーの ± と Field−

## テスト方針
- `classifyKey` の単体、ScreenGrid の公開メソッドで Field±、ペインでテンキーのキーを押す経路。実測の例。mutation。

## タスク
- [x] T1: 実測（ACS のコアで英数字欄と 6S0 の Field±・メイン行の `-`・`.`）。
      対象: `scripts/acs-probe/field-minus-keys.txt`
      依存: なし
      AC: AC1, AC2, AC3
- [x] T2: `classifyKey` のテンキー・ScreenGrid の素通し・`fieldSignKey` の 0022・`rejectReason`・`signKeyHack` の撤去。
      対象: `useKeymap.ts` `classifyKey`、`ScreenGrid.vue` `isNumpadSign` `fieldSignKey`、`fieldValidate.ts` `rejectReason`、`opMessages.ts`
      依存: T1
      AC: AC1, AC2, AC3
- [x] T3: テスト（新規と、旧い振る舞いを固定していた 6 件の書き換え）・mutation。
      対象: `test/numpad-field-sign.test.ts` `field-sign-dup.test.ts` `field-keystroke-rules.test.ts`
      依存: T2
      AC: AC4
