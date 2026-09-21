# レビュー: 起動応答を CCSID 37 で読む

## ラウンド 1（通過）
- 指摘なし。独立点検は節目でまとめて行う（PR #410 の方針）。

## ラウンド 2（節目の独立点検・マイルストーン 8。差し戻し）

別コンテキストのエージェントに 6 コミット（`7f192e11` / `3be3993a` / `65fa9200` / `57bf969b` / `4343eece` / `f446f419`）を、ACS の原典
（`PS5250.processBackspace`・`FFT5250.nextNonByPassInputFieldPos`・`PS5250.inputChar`・jt400 `AS400ImplRemote` / `ClassDecoupler` / `DDM*RequestDataStream`・
`DS5250.processStartUpConfirmation` / `extractNameFromStartUpConfirmationRecord`・ACS の文言表）と突き合わせて読ませた（全体で must 0・should 6・nit 5）。この work に関わる指摘と対応:
- [nit][conv:-] 確かめられなかった懸念: 名前の末尾の 0x00 を残していた（ACS `extractNameFromStartUpConfirmationRecord` は末尾の 0x00・0x40 を落とす） / 対応: 復号の前に末尾の 0x00・0x40 だけを落とす（先頭の空白は落とさない＝ACS と同じ）
- [nit][conv:-] 確かめられなかった懸念: ジョブの照会（`resolveJob`）が一覧の名前（ジョブの CCSID で読んだもの）で装置名を上書きし、930 では `$` が `¥` に化けうる / 対応: 名前は起動応答のまま、利用者と番号だけを採る（`test/session-manager.test.ts`）

## ラウンド 3（通過）

対応後の差分を主エージェントが点検。**指摘なし**。mutation 13 通り（`scratchpad/mut-m8.py`）を当て、1 回目に 1 つ生き残った（ジョブの照会の名前——テストが
照会の後の名前を「起動応答の名前」として取っていた。照会に使った名前と比べる形に直して検出）。全量は下の test-result。
