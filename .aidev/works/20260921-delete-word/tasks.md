# タスク: Delete Word と既定キーの訂正

## テスト方針
- 純ロジックの表（実機の測定をそのまま）、ScreenGrid・ペインを通す単体、保存済みの割り当ての移行。mutation。実機は変更前に ACS のコアで測った。

## タスク
- [x] T1: `deleteWordLength`・`deleteWord`・`local:delete-word`（ScreenGrid・ペイン・設定画面）と、エラー中の扱い・割り当て無しの修飾付き Backspace・Delete。
      対象: `packages/web-ui/src/composables/fieldEdit.ts` `packages/web-ui/src/components/ScreenGrid.vue` `packages/web-ui/src/components/EmulatorPane.vue` / 根拠: research A1, A2
      依存: なし
      AC: AC1, AC2, AC3
- [x] T2: 既定の割り当てと保存済みの割り当ての移行、README。
      対象: `packages/web-ui/src/stores/keybindings.ts` `README.md` / 根拠: research A3
      依存: T1
      AC: AC3, AC4
- [x] T3: テストと mutation、実機の測定の記録。
      対象: `packages/web-ui/test/delete-word.test.ts` `packages/web-ui/test/keybindings.test.ts` `packages/web-ui/test/host-error-mode.test.ts` `scripts/acs-probe/delete-word.txt`
      依存: T1, T2
      AC: AC1, AC2, AC3, AC4, AC5
