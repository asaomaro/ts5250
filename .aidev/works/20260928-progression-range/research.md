# 調査: カーソル送りの番号の範囲

## 判明した事実
- F1（原典 `FFT5250.nextNonByPassInputFieldPos` / `getNextCursorProgressionField` / `getStandardFieldList`）: `n2 > 0 && n2 <= this.size()`（欄の表の数）を検査し、
  `getStandardFieldList()`（スクロール・バーの欄と継続欄の 2 区間目以降を除く）の `elementAt(n2 - 1)` を引く。並びの数を超えると `ArrayIndexOutOfBoundsException`。
- F2（実機・ACS のコア・2026-09-28。DSM の PROGRANGE・`scripts/acs-probe/progression-range.txt`）: (3,10) 送り先 4・(5〜7,10) 継続欄 3 区間・(9,10) 送り先 1。
  a) (3,10) で Tab → `ArrayIndexOutOfBoundsException`・カーソル 3,10 のまま／b) (9,10) で Tab → 3,10／c) (3,10) に ABCDEF → 例外・カーソル 3,15（最終桁）。
- F3（当 PJ）: `packages/tn5250/src/screen/search.ts` の `progressionTarget` が並びで引き、外れれば `undefined` → ペイン（`EmulatorPane.vue` の `progressionStop`）と `tabPosition` が画面順へ倒す。
- F4: 当 PJ の `checkNewField`（`buffer.ts`）は ACS と同じく後ろの位置の欄がある所へ欄を足さない——欄の表は位置の昇順で、`standardFields` の画面順と一致。

## 実装アンカー
- A1: `packages/tn5250/src/screen/search.ts` `tabPosition`・`progressionTarget`
- A2: `packages/web-ui/src/components/EmulatorPane.vue` `focusByOffset`・`onFieldFull`
