# 決定記録

## D1: 送る値は `edits` と別に持つ（`SessionState.wire`）

- 背景: 最初は `edits` に印入りの値を入れたが、web-ui のテストが 30 件落ちた（`edits` は論理値を前提にする箇所が多い。research F4）
- 決定: `edits` は論理値のまま、AID の送信で使う印入りの値を `wire` に別に持つ
- 理由 / 代替案: `edits` を印入りにして各所で剥がす案は、剥がし忘れが静かに表示・比較を壊すので退けた
- 影響: `wire` の寿命は `edits`・`eitherDbcsOn` と同じ（`stores/sessions.ts` の 2 か所で消す）

## D2: 空の値には `wire` を付けない

- 背景: 空の E に形を付けると `SO` だけの値になり、コアが `eitherDbcsOn` から置く `0e`（`20260927-either-field-so`）と役割が重なる
- 決定: 空の値は従来どおり `eitherDbcsOn` だけで送る（既存の `either-field-so.test.ts` が固定）
- 影響: 空の J の欄（`0e`＋NUL＋`0f`）もコアの既存の道のまま

## D3: 自己起票の開始手順

- 実装とブラウザの突き合わせ（pass=3）を先に進め、aidev の work は後から起こした（上流 4 工程の記録は実装後の記述）。所要時間は実態より短く出る
