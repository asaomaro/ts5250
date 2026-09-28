# 決定記録

## D1: 「昇順でない定義」は差が無いので閉じる
- ACS の欄の表は `checkNewField` で常に位置の昇順（後ろの位置の欄がある所へは足さない）。当 PJ も同じ `checkNewField` を持つ（`20260927-wtd-sense-rest`）ので、並びの順は一致する

## D2: Field Exit・Field±・Dup で並びの外なら動かさない（原典の手順・未測定）
- ACS `processFieldPlusMinusAndExit` も `nextNonByPassInputFieldPos` を呼ぶので同じ例外になる。実測したのは Tab と満杯の自動送りだけ

## D3: acs-probe に `trykeys` を足した
- ACS のコアが打鍵の処理で例外を投げると probe が止まっていた。例外の種類を出して続け、その後の画面を `dump` で見られるようにした（例外そのものが測りたい事実）

## D4: 上流の文書は実装と実測の後に書いた（記録の順の注記）
- 実測（ACS の例外）が出てから実装に入り、requirements〜tasks の文書と工程の記録を後から付けた。工程の所要時間は実態と合わない
