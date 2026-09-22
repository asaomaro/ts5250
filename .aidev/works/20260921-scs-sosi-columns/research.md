# 調査: 帳票の SO/SI の桁

## 判明した事実
- F1（原典 `PrintSCS5250DB`）: コンストラクタで `spccBehavior = 1`（SPCC_DEFAULT）。`shiftOut` は spcc=1 のとき空白を 1 つ送り桁を 1 つ進める。
  `shiftIn` は spcc≠0 で 1 桁、spcc=2 ならさらに 1 桁。`setPresentationControlCharacter`（2B FD の 4 バイト目が 03）は長さ 2 か 4 だけを受け、
  4 なら続く 2 バイトを値とし 2 を超えれば 1 にする。ほかの長さ・4 バイト目はパラメーター・エラーで変えない。
  ⚠ 出力がファイルのとき（`!isSendPCL()`）は SPCC を無視する（既定の 1 のまま）。当 PJ は指定に従う側にした（D2）。
- F2（実機）: 日本語機の DSPLIBL の帳票（`scripts/verify-printer-dbcs-push.mjs` で採った生の SCS）は `2B FD 04 03 00 01`＝**1** を送ってくる。
  PUB400 の実採取の帳票 2 件（`packages/scs/test/fixtures`）は SPCC を送らない＝ACS では既定の 1。どちらでも ACS は SO/SI を 1 桁ずつ描く。
- F3（当 PJ）: `ScsDecoder` は SO/SI で桁を進めない。スプールの HTML は印を桁の境目に重ねる（`spool-html.ts` `markHtml`）。
  `20260728-scs-dbcs-column-align` D1 は「SO/SI に桁を与えると DBCS の行だけ 1 桁ずれて他の行と食い違う——ホストは SO/SI が桁を占めない
  前提で桁を組んでいる」とした。**ACS は DBCS の行を 1 桁右から描く**ので、この前提は ACS の描き方と違う。

## 実装アンカー
- A1: `packages/scs/src/scs.ts` の SO/SI の処理と `skip2b` の 2B FD
- A2: `packages/scs/src/spool-html.ts` `markHtml`
