# 決定記録

## D1: WTD・READ・ROLL・WRITE ERROR CODE の長さが足りなければ 0x10050121 で戻る（CC2 も落とす）

- 背景: research F1（原典）・F2（実機で ACS は 4 通りとも否定応答・CC2 を効かせない）。
- 決定: `tooShort(need, what)` を足し、4 つの入口で検査する。戻るのは `abortRecord`（`20260927-early-return-cc2`）。
- 影響: 0x22 の 0 バイトは否定応答になる（`20260926-wec-msgline-row` D4 のうち 0 バイトの場合を破棄——実機の SHORTWECW で ACS も否定応答。D4 に取り消し線と破棄先を書いた。`window-error-code.test.ts` を直した）。

## D2: CLEAR UNIT ALTERNATE の引数なしは変えない（backlog）

- ACS は `n5 > n2` で戻り、ちょうど引数が無いときは読み進める（F1）。当 PJ は読み過ぎの例外。実機で出させていないので測ってから決める。
