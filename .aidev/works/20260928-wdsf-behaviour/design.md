# 仕様: WDSF の中身の読み方

## 概要
parser で flag3・スクロール・バー付きの 8 バイト・2 進を直し、0x59 のフラグを読む。buffer の `removeByPos` は最初の 1 つだけ、`removeWindow` はフラグと種類を合わせ、窓の中の選択欄・スクロール・バーも外す。

## 依拠する既存の事実
- research F1〜F3。窓の範囲は罫線の穴と同じ（位置から幅＋6 桁・深さ＋2 行。`20260928-grid-window-hole`）

## 受け入れ基準との対応
- AC1: `parseSelectionItem` が flag3 に 0x80 が無ければ `null`
- AC2: `parseSelectionField` が flag2 0x80 で 8 バイト読み飛ばす
- AC3: `parseScrollBar` の `u32`
- AC4: `removeWindow(row, col, flag)`
- AC5: `removeByPos`
