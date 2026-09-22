# タスク: 既定のキー割り当てと End の行き先

## テスト方針
- 既定の中身・キーハンドラーの単体、ペインと ScreenGrid での結合（SBCS・DBCS）、保存値の移行。mutation。

## タスク
- [x] T1: 原典の確認（既定の表・End の意味・Alt View）。
      対象: `AcsMapFunctions.MAP_5250` `DefaultKeyboardRemap.getMapFile` `ECLPS` `PS5250.processEndField` `Field5250.getEndPosition` `CodePage.toggleAltView`
      依存: なし
      AC: AC1, AC3
- [x] T2: 版 4 の既定・Ctrl+F1/F3 の訂正・`hasKeyBinding`・IME のガード・ScreenGrid の委譲・`end` の行き先。
      対象: `keybindings.ts` `useKeymap.ts` `ScreenGrid.vue` `fieldEdit.ts`
      依存: T1
      AC: AC1, AC2, AC3, AC4
- [x] T3: テスト（新規と、旧い向き・旧い End を固定していたものの書き換え）・mutation・README。
      対象: `test/acs-default-keys.test.ts` `keybindings.test.ts` `view-cycle-ui.test.ts` `field-edit.test.ts` `README.md`
      依存: T2
      AC: AC5
