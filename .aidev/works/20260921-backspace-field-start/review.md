# レビュー: 欄の先頭の Backspace

## ラウンド 1（通過）
- 指摘なし。独立点検は節目でまとめて行う（PR #410 の方針）。

## ラウンド 2（節目の独立点検・マイルストーン 8。差し戻し）

別コンテキストのエージェントに 6 コミット（`7f192e11` / `3be3993a` / `65fa9200` / `57bf969b` / `4343eece` / `f446f419`）を、ACS の原典
（`PS5250.processBackspace`・`FFT5250.nextNonByPassInputFieldPos`・`PS5250.inputChar`・jt400 `AS400ImplRemote` / `ClassDecoupler` / `DDM*RequestDataStream`・
`DS5250.processStartUpConfirmation` / `extractNameFromStartUpConfirmationRecord`・ACS の文言表）と突き合わせて読ませた（全体で must 0・should 6・nit 5）。この work に関わる指摘と対応:
- [should][conv:-] `packages/web-ui/src/components/ScreenGrid.vue` DBCS の欄の先頭の Backspace・decisions D2 — 「ACS は原典の手順上 0101」は O の欄には当たらず、O の欄の先頭は 0005（`nextNonByPassInputFieldPos` は O の欄では SO を飛ばさない） / 対応: DSM に O・J の欄の画面を出させて ACS のコアで測った（`scripts/acs-probe/backspace-dbcs-field-start.txt`）——**O の欄の先頭も、J の欄の SO の後ろ（Tab の着地）も 0005**。点検の「J は 0101」も実測と違った。DBCS の欄も SBCS と同じく 0005 で止め、前の欄へ移る経路（`onFieldPrev`）を撤去。D2 を破棄（D3）

## ラウンド 3（通過）

対応後の差分を主エージェントが点検。**指摘なし**。mutation 13 通り（`scratchpad/mut-m8.py`）を当て、1 回目に 1 つ生き残った（ジョブの照会の名前——テストが
照会の後の名前を「起動応答の名前」として取っていた。照会に使った名前と比べる形に直して検出）。全量は下の test-result。
