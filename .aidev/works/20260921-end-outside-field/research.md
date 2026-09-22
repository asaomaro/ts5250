# 調査: ACS の欄の外の End

## 判明した事実
- F1（原典）: `PS5250.processEndField`: カーソルの下に欄が無ければ `FFT5250.nextNonByPassInputFieldPos(cursor)` で行き先を決め、その欄の `getEndPosition`
  （継続欄は `getEndPositionOfContField`）に置く。
- F2（原典）: `nextNonByPassInputFieldPos`: 欄の外ならカーソル送りは見ない。開始位置がカーソルより後で、バイパス（保護）でない最初の欄
  （継続欄は先頭の区切りだけ）。無ければ先頭の保護でない欄へ巡回。
- F3（当 PJ）: `EmulatorPane.vue` の局所操作 `end` は `focusInput(inputs, inputs.length - 1)`（最後の入力欄の先頭）。欄の中の End は ScreenGrid が `end`（`fieldEdit.ts`）で置く。
