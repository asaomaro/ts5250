# レビュー: ホストサーバーの認証の置換値

## ラウンド 1（通過）
- 指摘なし。独立点検は節目でまとめて行う（PR #410 の方針）。

## ラウンド 2（節目の独立点検・マイルストーン 8。差し戻し）

別コンテキストのエージェントに 6 コミット（`7f192e11` / `3be3993a` / `65fa9200` / `57bf969b` / `4343eece` / `f446f419`）を、ACS の原典
（`PS5250.processBackspace`・`FFT5250.nextNonByPassInputFieldPos`・`PS5250.inputChar`・jt400 `AS400ImplRemote` / `ClassDecoupler` / `DDM*RequestDataStream`・
`DS5250.processStartUpConfirmation` / `extractNameFromStartUpConfirmationRecord`・ACS の文言表）と突き合わせて読ませた（全体で must 0・should 6・nit 5）。この work に関わる指摘と対応:
- [should][conv:paired-artifact-sync!] `packages/hostserver/src/ddm/ddm-connection.ts` — DDM の SECCHK はレベルを見ずに SHA-1（末尾の空白もそのまま）で、サインオンとの間に非対称が生じていた。レベル 0/1 は DDM ごと断っていた / 対応: jt400 の DDM の経路（`getPassword`・`DDMACCSECRequestDataStream`・`DDMSECCHKRequestDataStream`）と同じく、置換値はサインオンと共用、ACCSEC の SECMEC はレベル 2 以上で 8・0/1 で 6、SECCHK は 20・64 バイトで 8・8 バイトで 6。**レベル 0 の実機でも DDM の握手が通るようになった**（社内機・PUB400 とも OK）
- [nit][conv:-] 確かめられなかった懸念: シード交換のクライアント属性（当 PJ 1・jt400 3）と、属性交換のデータストリーム・レベル（当 PJ 2・jt400 10）がレベル 4 の受け付けに関わるかもしれない / 対応: jt400 と同じ値にした。レベル 0・3 の実機でサインオン・DB・IFS・コマンド・DDM が通ることを確かめた（レベル 4 の実機は無く、効くかは未確認）

## ラウンド 3（通過）

対応後の差分を主エージェントが点検。**指摘なし**。mutation 13 通り（`scratchpad/mut-m8.py`）を当て、1 回目に 1 つ生き残った（ジョブの照会の名前——テストが
照会の後の名前を「起動応答の名前」として取っていた。照会に使った名前と比べる形に直して検出）。全量は下の test-result。
