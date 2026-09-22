# レビュー: SBCS のセッションの打鍵と MONOCASE

## ラウンド 1（通過）
- 指摘なし。独立点検は節目でまとめて行う（PR #410 の方針）。

## ラウンド 2（節目の独立点検・マイルストーン 8。差し戻し）

別コンテキストのエージェントに 6 コミット（`7f192e11` / `3be3993a` / `65fa9200` / `57bf969b` / `4343eece` / `f446f419`）を、ACS の原典
（`PS5250.processBackspace`・`FFT5250.nextNonByPassInputFieldPos`・`PS5250.inputChar`・jt400 `AS400ImplRemote` / `ClassDecoupler` / `DDM*RequestDataStream`・
`DS5250.processStartUpConfirmation` / `extractNameFromStartUpConfirmationRecord`・ACS の文言表）と突き合わせて読ませた（全体で must 0・should 6・nit 5）。この work に関わる指摘と対応:
- [should][conv:-] `packages/server/src/ws-handler.ts` attach — 既存のセッションへ attach したタブには実際の CCSID と関係なく 37 を返していたので、930・1399 の画面が「SBCS だけ」と判定され、全角を 1 バイトと数えて欄を越えて打てた / 対応: セッションの CCSID（`Session5250.ccsid`）を返す（`test/session-attach.test.ts`）。D2 の「分からない＝undefined」の前提も実態と違っていた
- [nit][conv:-] `ScreenGrid.vue` `inputChar` — ギリシャ文字の μ が MONOCASE で Μ になる（ACS は `hasMicroSymbol` なら先に µ へ置き換え、µ は大文字にしない） / 対応: SBCS だけのセッションでは μ を µ に置き換える（当 PJ の SBCS の CCSID はどれも µ を持つ）

## ラウンド 3（通過）

対応後の差分を主エージェントが点検。**指摘なし**。mutation 13 通り（`scratchpad/mut-m8.py`）を当て、1 回目に 1 つ生き残った（ジョブの照会の名前——テストが
照会の後の名前を「起動応答の名前」として取っていた。照会に使った名前と比べる形に直して検出）。全量は下の test-result。
