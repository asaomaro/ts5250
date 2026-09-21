# 調査

## 判明した事実
- F1: 原典（ACS `AcsMapFunctions.MAP_5250`）: `C36 = [rule]`・`C122 = [altcsr]`。
- F2: 当 PJ の `view:ruleLine`（罫線）・`view:cursorShape`（カーソルの形）は既にある（`viewSettings.ts`）。既定のキー（Ctrl+Home・Ctrl+F11）は他の用途に使われていない。

## 実装アンカー
- A1: `ADDED_BY_VERSION`（`packages/web-ui/src/stores/keybindings.ts`）。
