# レビュー

## ラウンド 1（通過）

バッチ処理の 1 件。**指摘なし**。独立点検は次の節目でまとめて行う。
- 申告を変えると英語機（PUB400）の DBCS では日本語が置換されるようになる（D1）。ACS と同じバイトを送る結果で、
  利用者の実機（日本語機）では逆に IGC の帳票が届くようになる。未確認（ACS そのものの PUB400）を記録に残した。

## ラウンド 2（節目の独立点検・14〜16 をまとめて。差し戻し）

別コンテキストのエージェントに `e332bc5c..3c8e8be4` の差分を、ACS の原典（DS5250P・PSNVT5250P・PrintSCS5250・PrintSCS5250DB・NVT5250・
PrintHostData。点検側で PrintSCS5250JPS も取り出した）と突き合わせて読ませた（must 0・should 12・nit 9）。この work に関わる指摘と対応:

- [should][conv:-] `printer-session.ts` — データの無いジョブの終わりでも帳票を確定し、データ → 終わり → CLEAR → 終わり で空の帳票（自動 PDF・自動印刷に
  白紙）を出した（ACS `sendEOJ` は印刷中でなければ何もしない） / 対応: データがあるときだけ確定（D4）。テスト 1 件
- [should][conv:measurement-sanity] `terminal-type.ts` — 英語機で DBCS の日本語が置換される退行を「ACS でも同じはず」で受け入れている / 対応: 未確認のまま
  記録に残した（ACS のプローブは表示セッション専用で、プリンターを測る手段がまだ無い）。送るバイト列が ACS と同じことはテストで固定済み
- [nit][conv:-] `printer-session.ts` — ACS は opcode より先にヘッダのバイト 4（終了のレコード 0x40）を見る / 対応: 同じ形にした。テスト 1 件
- [nit][conv:-] `telnet.ts` — 使われなくなった ibmFont ほかの口と「無いと 8925」のコメント / 対応: 撤去した
- [nit][conv:verify-by-mutation!] `printer-session.test.ts` — 本体が 0x00 以外の 1 バイトの例が無く、判定の片方を外しても落ちない / 対応: テスト 1 件
- [nit][conv:-] `verify-printer-dbcs-push.mjs` — CLROUTQ をせずに DLTOUTQ・`AS400_VRTCTL` がひな形に無い / 対応: 直した

## ラウンド 3（通過）

対応後の差分を主エージェントが点検。**指摘なし**。mutation（R-k・R-l）検出。
