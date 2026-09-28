# 調査: 罫線の寿命

## 判明した事実
- F1（原典）: WDSF 0x60 の罫線は `ENPTUI5250` の置き場（`GridBuf`）へ入り、DBCS の画面ならレコードの終わりに `mergeGridBuffer` で `PS5250.GridPlane` へ重ねる（`DS5250` のレコードの終わり）。
  CLEAR UNIT の `discardGridPlane` は `GridPlane` だけを捨て、置き場は画面の大きさが変わるときだけ捨てる。窓は `ENPTUIWindow.draw` で `clearGridBuf(位置, 幅＋6, 深さ＋2)`。
  0x5F（`removeAllGUIConstructs`）は置き場に触らない。0x61（`processClearGrid`）は区画 1・予約 2・行・桁・幅・深さの矩形だけを 0 にする。描画（`ScreenText`）は `ECLPSUpdate.GetGrid()`＝`GridPlane`。
- F2（実機・ACS のコア・2026-09-28。DSM の GRIDLIFE・`scripts/acs-probe/grid-lifetime.txt`。`grid` で `GridPlane` を読む）: 5,5 から 40×8 の箱で、
  G1 95 桁／G2 CLEAR UNIT のみ 95／G3 CLEAR UNIT ALTERNATE 95（このセッションは大きさが変わらない）／G4 窓（5,10・幅 20・深さ 5）69（上辺の 5,10〜5,35 の 26 桁が消えた）／
  G5 0x5F 95／G6 0x61（5,5・幅 10・深さ 1）85（5,5〜5,14）／G7 [罫線][CLEAR UNIT][欄] 95。
- F3（当 PJ）: 罫線は線の単位（`GuiGridLine`）。CLEAR UNIT は残す（一致）。窓は罫線に触らない、0x5F（`clearGui`）と 0x61（`clearGridLines`）は全部消していた（`packages/tn5250/src/screen/buffer.ts`）。
  窓の描画は枠だけ（背景は透明）なので、窓の中に罫線が透けて見える。

## 実装アンカー
- A1: `packages/tn5250/src/screen/buffer.ts` `addWindow`・`clearGui`・`clearGridLines`
- A2: `packages/tn5250/src/protocol/wdsf-parser.ts` 0x61・`wtd-applier.ts` の `remove-all`・`clear-grid-lines`
- A3: `packages/web-ui/src/components/ScreenGrid.vue` `gridSegments`
