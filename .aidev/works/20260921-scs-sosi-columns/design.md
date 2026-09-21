# 仕様: 帳票の SO/SI を ACS と同じ桁で描く

## 設計方針
- `decode` に SPCC の状態（既定 1）を持ち、SO・SI で ACS と同じ数の空白を置く。印（`shifts`）は SO/SI の桁を指す。
- 2B FD の 4 バイト目が 03 なら SPCC として読み、長さ 2・4 以外は受けない。
- スプールの HTML の印は幅を持たないまま、SO/SI の桁の左端に重なる（`left:(col-1)ch` はそのまま）。

## 依拠する既存の事実
- `markHtml` は `left:${col-1}ch` の幅 0 の要素（`packages/scs/src/spool-html.ts`）。

## 受け入れ基準との対応
- AC1: `scs.ts`。テスト（既定・SPCC 4 通り・長さ）。
- AC2: `spool-html.test.ts` の印の位置。
- AC3: mutation。
