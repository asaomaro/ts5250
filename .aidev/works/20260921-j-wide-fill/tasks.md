# タスク: J の詰め物

## テスト方針
- ScreenGrid を通す単体。mutation。実機は core の受理を確かめた。

## タスク
- [x] T1: `wideFill` の追加と `padDbcs`・`trimPad` への適用、既存の J のテストの期待値の更新、J の単体と mutation。
      対象: `packages/web-ui/src/components/ScreenGrid.vue` `packages/web-ui/test/dbcs-pure-field.test.ts` `packages/web-ui/test/dbcs-insert-room.test.ts` / 根拠: research A1
      依存: なし
      AC: AC1, AC2, AC3
