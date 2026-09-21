# レビュー: 数値専用の欄の Field−

## ラウンド 1（通過）
- 指摘なし。独立点検は節目でまとめて行う（PR #410 の方針）。

## ラウンド 2（節目 9 の独立点検。`scratchpad/review-milestone9.md`）
- [nit][conv:-] packages/web-ui/src/composables/fieldEdit.ts:237 送る前のゾーン D の桁が空白に見えた（ACS は `}`・`J`〜`R`）。D2 の「web-ui は表を持たない」は構造の都合 / 対応: `composables/zoneDigit.ts` で 0xD0〜0xD9 の 10 字だけを持ち、ScreenGrid の入力欄の表示に使う。当 PJ が扱う全 CCSID の変換表と一致することをテストで確かめた。D2 を破棄

## ラウンド 3（通過）
- 表示を直し、変換表との一致と入力欄の表示をテストで固定した。mutation で落ちることを確かめた。指摘なし。
