# 調査: J・G・全角の E の打った全角空白

## 判明した事実
- F1（実機。`space-typed.txt` の f0・f1・f5・2026-10-01）: J・全角の E（full）に `あ`＋全角空白は READ MDT `0e 4481 4040…0f`（空きの NUL の組も 40 40 になるため見分けがつかない）、ALT `0e 4481 4040 0000…0f`。J の先頭の全角空白だけも ALT で `0e 4040 0000…0f`
- F2（修正前のブラウザ）: 当 PJ は ALT で `0e 4481 0000…0f`（打った全角空白が消える）。空きを U+3000 で詰め、`trimPad` が末尾の U+3000 を落としていた
- F3（コード）: 値の詰め物は `padDbcs`（U+3000）、末尾の除去は `trimPad`、送る形は `jeExplicit`（死んだ桁の印の組で詰める）、画面の読み戻しは `logicalFromCells`（空き＝生バイトの無い空白）

## 影響範囲
- `packages/web-ui/src/components/ScreenGrid.vue`・`composables/fieldValidate.ts`・`mandatoryCheck.ts`

## 実装アンカー
- A1: `ScreenGrid.vue` `trimPad`・`padDbcs`・`logicalFromCells`・`jeExplicit`・`widenNul`

## design への申し送り
- 全角 1 桁の空きの専用の文字を値に持つ（打った全角空白 U+3000 と区別する）。見えるのは全角空白、ホストへは NUL の組
