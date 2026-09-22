# タスク: 語頭ジャンプ

## テスト方針
- 純関数の表（実機の測定）・ペイン結合・キー分類。mutation。

## タスク
- [x] T1: `nextWordStart` の語頭の規則と巻き戻り、Alt+←/→ の割り当て、テストと mutation、実機の測定の記録。
      対象: `packages/web-ui/src/composables/useCursor.ts` `packages/web-ui/src/composables/useKeymap.ts` `packages/web-ui/test/use-cursor.test.ts` `packages/web-ui/test/keymap.test.ts` `packages/web-ui/test/pane-word-jump-input.test.ts` `scripts/acs-probe/tabword.txt` / 根拠: research A1
      依存: なし
      AC: AC1, AC2, AC3
