# 仕様: WEA の否定応答

## 概要
`case ORDER.WEA` の読み飛ばしを、ACS の検査の順の 3 つの否定応答に置き換える。

## 設計方針
長さ不足（既存）→ 画面の外（`addr >= rows*cols`）→ タイプ（5 以外・SBCS のセッション〔`codec.decodeDbcsPair` が無い〕）→ 値（0x81・0x80・0x00 以外）。センスは `SENSE` に ACS の名前どおり足す（0x1005012D は EA の `EA_LENGTH` と同じ値だが、名前を `ATTRIBUTE_TYPE` として別に持つ）。

## 対象範囲
- `wtd-applier.ts`、テスト、`dscmd.c`・`verify-wtd-order-sense.mjs`・`acs-probe/wea-sense.txt`

## 依拠する既存の事実
- `fail` は WTD を打ち切り CC2 を効かせる（`20260927-wtd-order-sense`。`wtd-applier.ts` の `fail`）
- EA で最後の桁まで消すと位置は画面の外に残る（`20260927-ea-acs`。`eaAtEnd`）

## 受け入れ基準との対応
- AC1: `wtd-applier.test.ts`・`dbcs-pure-field.test.ts`（research F2 の値）
- AC2: `verify-wtd-order-sense.mjs` に WEA の 4 モード（SBCS は PUB400）
- AC3: DLTPGM と IFS の削除（両方の実機）
