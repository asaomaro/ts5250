# 調査

## 判明した事実
- F1: 実機に繋いだ core（社内機・GTST の J）: `setField(J, "あ   い")` は FIELD_TYPE「accepts double-byte characters only」、`あ　　　い` は通る。
- F2: `20260921-g-field-sosi` の実機の測定: 当 PJ の J は短い形（`0e … 0f`）で送るが、ホストの受け取りは ACS と同じ `0e … 40 40 40 40 0f`（ホストが整える）。
- F3: 当 PJ の `padDbcs`（`ScreenGrid.vue`）は J・E・O の詰め物を半角空白にしていた（G は `20260921-g-field-sosi` で全角空白にした）。

## 実装アンカー
- A1: `wideFill`・`trimPad`・`padDbcs`（`packages/web-ui/src/components/ScreenGrid.vue`）。
