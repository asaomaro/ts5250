# 仕様: DS5250 のその他の差

## 依拠する既存の事実
- `closeWindowsAndSelections` は窓・選択欄・スクロール・バーを閉じ、罫線は触らない（`buffer.ts`）

## 受け入れ基準との対応
- AC1: `clearFormatTable(kind)`——`"cft"` は `closeWindowsAndSelections`、`"soh"` は選択欄・スクロール・バーだけ捨てる。SOH の呼び出しが `"soh"` を渡す
- AC2: 台帳の行を割り、残りを別の `[ ]` に
