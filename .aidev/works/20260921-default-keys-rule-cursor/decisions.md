# 決定記録

## D1: ACS の既定のうち、機能があって既定のキーだけが無かったものを版 5 で足す
- 原典: `AcsMapFunctions.MAP_5250` の `C36 = [rule]`・`C122 = [altcsr]`。当 PJ の `view:ruleLine`・`view:cursorShape` に Ctrl+Home・Ctrl+F11 を割り当てた（他の用途と衝突しない）。
- ACS の `[altcsr]` はブロック⇄下線の 2 値の切り替え。当 PJ の `cursorShape` は選択肢の順送り（Ctrl+F11 を押すたびに次の形）。
- 既定の下線（ACS）とブロック（当 PJ の既定。`viewSettings.ts`）の差は別の話（利用者の見え方の選択）で、ここでは触れない。

## D2: 測っていないもの（未確認）
- GUI 層のキー（ACS の Ctrl+Home が実際に罫線を出すか）は headless のコアで測れない。原典の割り当て表の読み。
