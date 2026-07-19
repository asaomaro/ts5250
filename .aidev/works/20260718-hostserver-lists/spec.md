# 仕様: オブジェクト・ユーザー一覧

## 設計方針

### D1: QGY の共通部分を切り出して共有する
`list/openlist.ts` に「呼び出し → リスト情報の解析 → レコードの切り出し」をまとめ、
オブジェクト・ユーザーの両方から使う。スプール一覧も将来ここへ寄せられる。

### D2: サーバーの申告件数を鵜呑みにしない
research F3 のとおり、受信変数に入りきらなくても全件数が申告されることがある。
**入りきる件数**と**空レコード**の両方で打ち切る。

### D3: 出力パラメータの位置を型ドキュメントに明記する
research F4 のとおり、リスト情報の位置を誤ると**エラーが出ないまま 0 件**になる。
同じ轍を踏まないよう、`listInfoIndex` の根拠をコメントに残す。

## 対象範囲

新規: `packages/core/src/hostserver/list/`
- `openlist.ts` — QGY 共通
- `job-list.ts` — `QGYOLJOB`
- `object-list.ts` — `QGYOLOBJ`
- `user-list.ts` — `QSYRAUTU`
