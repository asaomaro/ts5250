# レビュー

## ラウンド 1（通過）

バッチ処理の 1 件。**指摘なし**。独立点検は次の節目でまとめて行う。
- 台帳の「ACS は長さの前置を見て汎用に読み飛ばす」は、表にあるクラスについてだけ正しかった（表に無いクラスは 0x2B の 1 バイト）。台帳を直した。

## ラウンド 2（節目の独立点検・14〜16 をまとめて。差し戻し）

別コンテキストのエージェントに `e332bc5c..3c8e8be4` の差分を、ACS の原典（DS5250P・PSNVT5250P・PrintSCS5250・PrintSCS5250DB・NVT5250・
PrintHostData。点検側で PrintSCS5250JPS も取り出した）と突き合わせて読ませた（must 0・should 12・nit 9）。この work に関わる指摘と対応:

- [should][conv:-] 全体 — ACS の SCS の読み方は 2 経路あり、既定（Windows・HPT なし）は JPS なのに PDT に合わせていた / 対応: JPS に合わせ直した（D4・research F5 F6）
- [should][conv:-] `scs.ts` TRN — JPS は本体を `-` にする / 対応: 直した
- [should][conv:-] `scs.ts` VCS — PDT は LF だが JPS は何もしない / 対応: JPS どおり何もしない
- [should][conv:-] `scs.ts` 2B CA / D4 — 表に無く、0x2B だけ捨てて本文が崩れた / 対応: 長さで読む（JPS の表）。テスト 1 件
- [should][conv:-] `scs.ts` SA 28 43 F8 / 00 — PDT の DB だけにある DBCS の切り替え / 対応: 既定の JPS には無いので入れない（D4 に記録）
- [should][conv:verify-by-mutation!] `scs.test.ts` — 未知の 2B のクラスが 0x07 で `seek` を外しても落ちない / 対応: クラスを印字文字にした例を足した
- [nit][conv:-] `scs.ts` — 古い記述（打ち切り・TRANSPARENT 0x03 ほか） / 対応: 直した
- [nit][conv:-] `scs.ts` — 2B の長さ 0・GE の次が 0x40 未満・HT・BS の境界 / 対応: HT は JPS の 1 桁、BS は JPS の何もしない、GE は JPS の何もしない。
  長さ 0 は ACS と結果が同じ（次の 0x00 が Null）なので分岐を置かない

## ラウンド 3（通過）

対応後の差分を主エージェントが点検。**指摘なし**。mutation（R-d〜R-g・R-m・R-n）検出（R-n は 1 回目に生き残り、テストの余りのバイトを
印字文字にして検出）。
