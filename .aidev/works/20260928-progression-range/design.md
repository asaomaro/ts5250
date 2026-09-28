# 仕様: カーソル送りの番号が並びの外なら動かない

## 概要
`progressionStuck(fields, n)`（`n > 0 && n <= 欄の数 && n > 並びの数`）を `search.ts` に置き、`tabPosition` は元の位置を返す。ペインは Tab で動かず、満杯の自動送りは欄の最終桁へ、
Field Exit・Field±・Dup は動かさない。

## 依拠する既存の事実
- research F1〜F4（`search.ts:134` `progressionTarget`・`EmulatorPane.vue` `progressionStop`・`onFieldFull`・`focusByOffset`）
- 欄の数はスナップショットの `fields.length`（区間・保護欄を含む。ACS の `size()` と同じ集合——スクロール・バーの欄はどちらにも無い）

## 受け入れ基準との対応
- AC1: `tabPosition`・`focusByOffset` が `progressionStuck` で止まる。入力はスナップショットの欄
- AC2: `onFieldFull` が最終桁へカーソルを置く（Field Exit 等は動かさない——原典の手順。実測は満杯だけ）
- AC3: `progressionStuck` の境界
