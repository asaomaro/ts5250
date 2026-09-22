# 調査: ACS のテンキーの ± と Field−

## 判明した事実
- F1（原典）: `AcsMapFunctions.MAP_5250`: `B109 = [field-]`・`B107 = [field+]`（修飾なしのテンキー）。他に Field± の割り当ては無い。
- F2（原典）: `PS5250.processFieldPlusMinusAndExit`（Field+・Field−・Field Exit 共通）: 欄外 0005・入出力欄 0004・ME の先頭か MDT なし 0033・MF の部分入力 0020、
  **Field− は符号付き数値・数値専用でない欄か継続欄で 0022**。通れば EOF 消去・右寄せ、符号付きは Field− で符号桁に `-`、数値専用の Field− は
  最終桁のゾーンを D に（`EnableFieldMinus` が無ければ表示も）。その後は自動実行なら Enter、でなければ次の欄。
- F3（原典）: `checkSBCSField`: 符号付き数値は数字（と NUL）だけ、符号桁はエラー 0017。数値専用は `Field5250.checkNumericOnlyChar`（数字・空白・`,` `-` `.` `+`）。
- F4（実機・ACS のコア。`scripts/acs-probe/field-minus-keys.txt`。ADJPGM）: 英数字欄に `AB` → Field− → エラー・値とカーソル（13,22）そのまま ／ Field+ → 次の欄 15,20 ／
  6S0 に `12-` → `12` のままエラー（19,22）／ Field− → `    12-`・次の欄へ ／ `.` → エラー。
- F5（当 PJ）: `ScreenGrid.vue` の `signKeyHack`（GNU tn5250 の `sign_key_hack` 由来）、`fieldSignKey` は欄の型を見ない、`fieldValidate.ts` の
  `rejectReason` は数値 3 種をまとめて `[0-9.,+\-\s]`。`classifyKey` は `KeyboardEvent.code` を見ていない。
