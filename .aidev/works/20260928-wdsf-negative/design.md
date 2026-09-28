# 仕様: WDSF の構造体ごとの否定応答

## 概要
`applyWdsf` の型の検査の直後に `wdsfShapeSense(type, LL, sf, buf)` を呼び、センスが返れば否定応答（WTD を打ち切る）。添字は ACS と同じく LL の先頭から数える。

## 依拠する既存の事実
- research F1〜F3。否定応答で WTD を打ち切る仕組みは既存（`applyWtd` の `fail`）

## 受け入れ基準との対応
- AC1: `wdsfShapeSense` の各型の枝
- AC2: `scripts/verify-wdsf-negative.mjs`
