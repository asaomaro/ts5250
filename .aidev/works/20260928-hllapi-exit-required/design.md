# 仕様: HLLAPI のエラー 0x20

## 概要
接続ごとに「打ったまま欄を出ていない欄」（`Connection.unexited`）を持つ。右寄せ・符号付き数値の欄に打って欄の終わりに着かなければ立て、欄の終わりまで打つか、Tab・Backtab・Home・上下の矢印でその欄に着けば下ろす。
AID の前の検査で、カーソル下の欄が `unexited` で MDT があれば `rc=5`（カーソルは動かさない）。順は ACS と同じ MF → 0x20 → 自己点検 → ME。送ったら下ろす。

## 依拠する既存の事実
- research F1〜F3。`needsFieldExit` の条件はペイン（`packages/web-ui/src/composables/mandatoryCheck.ts`）と同じ
- MF だけの判定は `hllapi-leave-check.ts` の `mandatoryFillViolated`（非公開）——`mandatoryFillOnly` として出す

## 受け入れ基準との対応
- AC1: `aidCheck` の 0x20。`Set Cursor` と左右の矢印は `unexited` を下ろさない
- AC2: `ARRIVAL_ACTIONS` と欄の終わりの判定。`needsFieldExit` は自動 Enter を外す
- AC3: `scripts/verify-hllapi-exit-required.mjs`
