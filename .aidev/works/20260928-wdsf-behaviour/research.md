# 調査: WDSF の中身の読み方

## 判明した事実
- F1（原典。scratchpad の `wdsf-sense-diff.md` に抜き書き）: `ENPTUIChoiceText` は flag3 に 0x80 が無ければ例外で捨てる。`ENPTUIChoiceSelectionField` はスクロール・バー付き（flag2 0x80）なら
  20〜27 バイト目が総数・位置（2 進）でマイナーは 28 バイト目から（型 01・11・12・41・51 は否定応答 0x10050112）。`ENPTUIScrollBarField` の総数・位置は 32 ビットの 2 進。
  `removeGUIWindow` はフラグ 0x40＋引き下げの窓／0x00＋普通の窓だけを外し、外した窓の中の選択欄・スクロール・バーも外す。`removeGUISelectionField`・`removeGUIScrollBarField` は番地の一致する最初の 1 つだけ。
- F2（実機・ACS のコア・2026-09-28。DSM の WDSFBEH・`scripts/acs-probe/wdsf-behaviour.txt`）: W1 AAA・CCC（BBB が無い）／W2 型 0x21 のリストで DDD・EEE と矢印／
  W3 制限つきの普通の窓に 0x59 フラグ 0x40 → 上へ 3 回でカーソル 10,14（窓の中で回り込む＝窓が残る）／W4 フラグ 0x00 → 4,14（窓が外れた）。
- F3（当 PJ）: `packages/tn5250/src/protocol/wdsf-parser.ts` は flag3 の上位 3 ビットが 0 なら空の選択肢を残し、マイナーは常に 20 バイト目から、スクロール・バーは 10 進 4 桁。
  `buffer.ts` の `removeByPos` は一致が無ければ全部外し、0x59 はフラグを見ない。

## 実装アンカー
- A1: `wdsf-parser.ts` `parseSelectionField`・`parseSelectionItem`・`parseScrollBar`・0x59
- A2: `buffer.ts` `removeByPos`・`removeWindow`・`wtd-applier.ts` の `remove-window`
