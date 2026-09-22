# タスク: 欄の先頭の Backspace

## テスト方針
- ScreenGrid とペインのテスト（0005・動かない・続けて打てない）。mutation。

## タスク
- [x] T1: 実測と、ScreenGrid の SBCS・行をまたぐ欄の 0005。旧い動きを固定していたテストの書き換え。
      対象: `packages/web-ui/src/components/ScreenGrid.vue` `test/field-boundary-backspace.test.ts` `test/continued-field-edit.test.ts` `scripts/acs-probe/backspace-field-start.txt`
      依存: なし
      AC: AC1, AC2, AC3
