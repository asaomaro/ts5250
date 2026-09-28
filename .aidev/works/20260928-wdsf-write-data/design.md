# 仕様: WDSF 0x54

## 概要
parser が `{ kind: "write-data", flag, data }` を返し、applier の `writeFieldData` が検査・消去・書き込みをする。`applyWdsf` は番地を返せるようにし、呼び出し側が進める。
書き込みは WTD の文字の並びと同じ読み方（SO/SI・並びの中の 2 バイト・1 バイト・NUL）の `writeHostBytes`。欄の消去は `ScreenBuffer.eraseFieldCells`（MDT に触らない）。

## 依拠する既存の事実
- research F1〜F3。WTD の文字の書き方は `applyWtd` の文字の並びの処理（`wtd-applier.ts`）

## 受け入れ基準との対応
- AC1: `writeFieldData` の継続でない枝と番地の戻り値
- AC2: 欄の先頭・長さの検査
- AC3: 継続欄の割り方
- AC4: flag の検査
