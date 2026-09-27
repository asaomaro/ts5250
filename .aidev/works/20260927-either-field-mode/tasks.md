# タスク: E 欄の半角・全角

## 実装方針
web-ui の打鍵経路。

## 作業順序と依存関係
下の `依存:` に従う。

## リスク / 留意点
- 既存の DBCS のテストが変わらないこと。

## テスト方針
- 新しいテストと DBCS・IME のテスト。変異: 規則を外す。

## タスク
- [x] T1: `eitherModeSwitch` と打鍵・IME の経路・文言
      対象: `packages/web-ui/src/components/ScreenGrid.vue`・`packages/web-ui/src/composables/opMessages.ts` / 根拠: research A1
      依存: なし
      AC: AC1, AC2
- [x] T2: テスト・実機の測定と片付け
      対象: `packages/web-ui/test/either-field-mode.test.ts`・`scripts/acs-probe/either-field-mode.txt`
      依存: T1
      AC: AC1, AC2, AC3
- [x] T3: 全角の状態をコアに持たせ、スナップショットで渡す（decisions D4。独立点検 T1 の must から足した）
      対象: `packages/tn5250/src/screen/buffer.ts` `InternalField.eitherDbcsOn`・`setShift`・`setFieldValue`／`packages/tn5250/src/screen/types.ts` `Field`／`packages/tn5250/test/either-dbcs-flag.test.ts`
      依存: T1
      AC: AC1
