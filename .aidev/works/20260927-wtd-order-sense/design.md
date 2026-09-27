# 仕様: WTD の中のオーダーの誤り

## 概要
`applyWtd` のオーダーの入口に ACS と同じ検査を入れ、誤りは `fail` で否定応答にして WTD を打ち切る（decisions D1）。

## 設計方針
ACS の条件を 1 つずつ写す（research F1）。CC2 は落とさない（ACS の尾部は走る）。

## 対象範囲
- `packages/tn5250/src/protocol/wtd-applier.ts`（`SENSE` に 4 つ、`applyWtd` の `fail`・`inScreen` と SBA・IC・MC・RA・EA・SOH・TD・SF・WEA、主ループ）
- テスト: `packages/tn5250/test/wtd-order-sense.test.ts`（新規）
- 実機: `scripts/host-src/dscmd.c` の WTDERR*・`scripts/acs-probe/wtd-order-sense.txt`・`scripts/verify-wtd-order-sense.mjs`
- 台帳: 「SOH の長さが 0 か 8 以上」も閉じる

## 依拠する既存の事実
- オーダーのバイトは switch の前に読み進めている（`applyWtd` の `r.u8()`）
- `settleCursor`（WTD の終わりのカーソルの確定）・`warnUnmappable` は WTD の正常な終わりで呼ぶ（`applyWtd`）——`fail` でも呼ぶ
- `buf.addrOf` は画面の外で例外（`packages/tn5250/src/screen/buffer.ts`）——検査の後にだけ呼ぶ

## インターフェース / データ構造
- `SENSE.ORDER_ADDRESS`（0x10050122）・`ORDER_BACKWARD`（0x10050123）・`SOH_LENGTH`（0x1005012B）・`EA_LENGTH`（0x1005012D）

## 振る舞いの詳細
- 誤り: 否定応答・誤りの前の書き込みとカーソルの確定は残す・CC2 は効く・レコードの残りは読まない

## エラー処理 / 異常系
- SBA の 1,0・SF の中身の誤りは従来どおり例外（backlog）

## 受け入れ基準との対応
- AC1: research F2・F3
- AC2: `wtd-order-sense.test.ts`
- AC3: DLTPGM（CPC2191・CHKOBJ で CPF9801）・IFS の削除・ワイヤの記録の shred
