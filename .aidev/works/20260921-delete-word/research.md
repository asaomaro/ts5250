# 調査

## 判明した事実
- F1: 原典（ACS `AcsMapFunctions.MAP_5250`）: `C127 = [deleteword]`・`C8` 無し・`[eraseeof]` の割り当て無し・`A35 = [erinp]`。`PS5250.processDeleteWord` は `processDeleteChar(n, true)`（MDT・0005 などは Delete と同じ）。
- F2: 原典（`PS5250.keyDown`）: 操作員エラー中に拒否するのは Backspace・Erase EOF・Erase Input・Erase Field・Delete・Field±・Field Exit・Dup・Field Mark と文字だけ。`[deleteword]`（63623）は含まれない。
- F3: 実機の ACS のコア（社内機・930。dump は `scratchpad/delete-word*.out`・`dw-d7.out`）: a〜l（コマンド行）・d1〜d8（DBCSFE の O 欄）・m（エラー中）・B8（継続欄）。すべて上の要件のとおり。
- F4: 当 PJ の既定は `keybindings.ts` の `ADDED_BY_VERSION`（版 2 に Ctrl+Delete＝Erase EOF・Ctrl+Backspace＝Erase Input）。保存済みの割り当ての訂正は `CORRECTED_BY_VERSION`（値の置換だけ）。

## 実装アンカー
- A1: `deleteWordLength`・`deleteWord`（`packages/web-ui/src/composables/fieldEdit.ts`）と `deleteWordKey`・`dbcsDeleteWord`（`ScreenGrid.vue`）。
- A2: `LOCAL_EDIT_ACTIONS`（`useKeymap.ts`）・`onLocal`・`isEditingKey`（`EmulatorPane.vue`）・`KeybindingsPanel.vue`。
- A3: `ADDED_BY_VERSION`・`CORRECTED_BY_VERSION`・`load`（`packages/web-ui/src/stores/keybindings.ts`）。
