# 仕様: 罫線の寿命

## 概要
罫線に「穴」（`GuiGridLine.holes`。1 始まりのセルの矩形）を持たせ、窓を作ったとき・0x61 のときにそれまでの罫線へ穴を足す。画面は線分を穴で削って描く。0x5F は窓・選択欄・スクロール・バーだけを外す。

## 設計方針
ACS の置き場はセルごとの印だが、当 PJ は線の単位なので、線を分解せず「どこが消えたか」を持たせる。線の持ち主のセルは ACS の置き場の印の置き方（上辺・左辺は線の下・右のセル、下辺・右辺は上・左のセル）に合わせる。
内部の罫（箱の中の横罫・縦罫）の持ち主は原典で追っていないので、下・右のセルとみなす（未確認）。

## 依拠する既存の事実
- research F1〜F3。窓の位置は `addWindow` の `row`/`col`（WDSF の直前の番地。`wtd-applier.ts` の `buf.rowColOf(addr)`）

## 受け入れ基準との対応
- AC1: `addWindow` が穴を足す・`gridSegments` が削る
- AC2: `removeAllGuiConstructs`
- AC3: 0x61 の矩形を読んで `clearGridRect`
- AC4: `scripts/verify-browser-grid-lifetime.mjs`
