# 調査

## 判明した事実
- F1: 原典（ACS `ECLPS.is1stCharacter`）: SO/SI は語頭でない・全角は `IsDBCS1stChar`（1 字ごと）・空白は語頭でない・先頭の桁は語頭・直前が空白か SI なら語頭。`get1stCharPosition` は画面の全桁ぶんを端で巻き戻ってたどる。
- F2: 実機の ACS のコア（社内機・930）: メニューの 1 行目で (1,1) → 2 → 30 → 34 → 36 → 38 → 40 → 42 …、2 行目の `システム:` で 59・61・63・65・68（SI の直後の `:`）・72（システム名）。
  画面の端: `w1`（24,80 から前へ）は (1,2)、`w2`（1,1 から後ろへ）は (24,32)。
- F3: 当 PJ の `nextWordStart`（`useCursor.ts`）は非空白の連なりを語・各行の 1 桁目を常に語頭・端で停止だった。Alt+←/→ は `classifyKey` の対象外（App のショートカットは Alt+Shift 系）。

## 実装アンカー
- A1: `nextWordStart`（`packages/web-ui/src/composables/useCursor.ts`）、`classifyKey`（`useKeymap.ts`）。
