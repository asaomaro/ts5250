# 仕様: EA の扱い

## 概要
`applyWtd` の EA を ACS の `eraseToAddress` と同じにする（decisions D1）。

## 設計方針
原典の手順（research F1）をそのまま写し、実機の結果（F2）で確かめる。

## 対象範囲
- `packages/tn5250/src/protocol/wtd-applier.ts` の `case ORDER.EA`、`applyWtd` の `runLength`・`runEnd`・`eaAtEnd`（画面の終わり）・`WTD_ORDERS`、`applyDataStream` の `abort`
- テスト: `packages/tn5250/test/wtd-order-sense.test.ts`（describe「EA の属性タイプと書き始め」と境界）・`packages/tn5250/test/wtd-applier.test.ts`（EA）
- 実機: `scripts/host-src/dscmd.c` の EATEST*・`scripts/acs-probe/ea-acs.txt`・`scripts/verify-ea-acs.mjs`・`scripts/README.md`

## 依拠する既存の事実
- EA の長さ・行・桁の検査（`20260927-wtd-order-sense`）は前段にあり、そのまま
- DBCS のセッションかは codec の `decodeDbcsPair` の有無（`wtd-applier.ts` の WEA と同じ見方）

## インターフェース / データ構造
- 変更なし

## 振る舞いの詳細
- research F1 のとおり

## エラー処理 / 異常系
- 0x1005012D・0x10050123 は `fail`（CC2 は効く）
- 画面の終わりを越える並びは `abort`（0x10050121・CC2 を落とす。`abortRecord`）
- 位置が画面の大きさになったら、EA の後でなければ 0 に戻す（ACS の `writeString` の割った余り）

## 受け入れ基準との対応
- AC1: research F2・F3
- AC2: `wtd-order-sense.test.ts`・`wtd-applier.test.ts`
- AC3: 片付け（DLTPGM・IFS・ワイヤの記録）
