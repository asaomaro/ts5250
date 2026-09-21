# レビュー: 数値専用の欄の Field−

## ラウンド 1（通過）
- 指摘なし。独立点検は節目でまとめて行う（PR #410 の方針）。

## ラウンド 2（節目 9 の独立点検。`scratchpad/review-milestone9.md`）
- [nit][conv:-] packages/web-ui/src/composables/fieldEdit.ts:237 送る前のゾーン D の桁が空白に見えた（ACS は `}`・`J`〜`R`）。D2 の「web-ui は表を持たない」は構造の都合 / 対応: `composables/zoneDigit.ts` で 0xD0〜0xD9 の 10 字だけを持ち、ScreenGrid の入力欄の表示に使う。当 PJ が扱う全 CCSID の変換表と一致することをテストで確かめた。D2 を破棄

## ラウンド 3（通過）
- 表示を直し、変換表との一致と入力欄の表示をテストで固定した。mutation で落ちることを確かめた。指摘なし。

## ラウンド 4（節目 10 の独立点検。`scratchpad/review-milestone10.md`）
- [nit] packages/web-ui/src/composables/fieldEdit.ts:241 数値専用欄の Field− の最終桁は、表にない字（ホストが入れた英字など）を 0xD0 にするが、ACS は実際のバイトの下位 4 ビットを使う（`A`＝0xC1 は 0xD1）。数値専用欄に英字が入る構成は稀 / 対応: コメントに残し、台帳へ

## ラウンド 5（通過）
- 節目 10 の指摘（nit 1）を注記と台帳で直した。同じ点検の記録の同期漏れ（`fieldEdit.ts` の JSDoc・`ScreenGrid.vue` の注記・台帳の「表示は残り」）も取り消し線で直した（件数は `20260921-field-exit-checks` に数えた）。指摘なし。
