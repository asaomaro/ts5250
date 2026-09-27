# 調査: DS5250 のその他の差

## 判明した事実
- F1: ACS `DS5250.processClearFMT(bl, bl2)` → `FFT5250.clearFFT(bl2)` → `ENPTUI5250.clearENPTUIConstructs(bl2)`: `bl2` が真なら窓（型 1）も含めすべての構造体を無効にし、偽なら窓だけ残す。CU・CUA・CFT は `processClearFMT()`（真）、SOH は `processClearFMT(true, false)`（偽）。`removeConstructAt` は要素を消さず無効にするだけ（取りこぼしは無い）
- F2: 当 PJ（直す前）: `clearFormatTable` は窓・選択欄・スクロール・バーに触れない（`buffer.ts`）。CU・CUA は `closeWindowsAndSelections` で全部閉じる
- F3: ACS `processClearUnit` は `discardGridPlane` で罫線の面も捨てる。一方、`buffer.ts` の `closeWindowsAndSelections` の注記は、実機（S9R167D）で罫線を描いた後に同じレコードで CLEAR UNIT が来ても ACS が罫線を表示し続けたと記す——原典と実測が食い違う
- F4: ACS `processClearUnit` は `resetRow1Col0Attr` を呼ぶ（当 PJ も `20260927-wtd-sense-rest` で `row1col0Attr` を CLEAR UNIT で捨てる）

## 実装アンカー
- A1: `packages/tn5250/src/screen/buffer.ts` `clearFormatTable`・`packages/tn5250/src/protocol/wtd-applier.ts` の SOH
