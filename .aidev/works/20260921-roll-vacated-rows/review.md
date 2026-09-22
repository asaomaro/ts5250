# レビュー: ROLL

## ラウンド 1（通過）
- 指摘なし。独立点検は節目でまとめて行う（PR #410 の方針）。

## ラウンド 2（節目の独立点検・マイルストーン 8。差し戻し）

別コンテキストのエージェントに 6 コミット（`7f192e11` / `3be3993a` / `65fa9200` / `57bf969b` / `4343eece` / `f446f419`）を、ACS の原典
（`PS5250.processBackspace`・`FFT5250.nextNonByPassInputFieldPos`・`PS5250.inputChar`・jt400 `AS400ImplRemote` / `ClassDecoupler` / `DDM*RequestDataStream`・
`DS5250.processStartUpConfirmation` / `extractNameFromStartUpConfirmationRecord`・ACS の文言表）と突き合わせて読ませた（全体で must 0・should 6・nit 5）。この work に関わる指摘と対応:
- [nit][conv:comment-provenance!] `packages/tn5250/src/protocol/wtd-applier.ts` ROLL — 「実機で ROLL を送ってくる画面は見つかっていない・根拠は原典 2 実装の一致だけ」が、DSM での実測と `PS5250.processRoll` の突き合わせの後も残っていた / 対応: 取り消し線で直し、実測の在処を書いた

## ラウンド 3（通過）

対応後の差分を主エージェントが点検。**指摘なし**。mutation 13 通り（`scratchpad/mut-m8.py`）を当て、1 回目に 1 つ生き残った（ジョブの照会の名前——テストが
照会の後の名前を「起動応答の名前」として取っていた。照会に使った名前と比べる形に直して検出）。全量は下の test-result。
