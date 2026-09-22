# レビュー

## ラウンド 1（通過）

バッチ処理の 1 件。**指摘なし**。独立点検は次の節目でまとめて行う。
- 過去の決定（`20260728-scs-dbcs-column-align` D1）を ACS の原典で破棄した。見た目（DBCS の行が 1 桁右から始まる）が変わるので、PR に明記する。

## ラウンド 2（節目の独立点検・14〜16 をまとめて。差し戻し）

別コンテキストのエージェントに `e332bc5c..3c8e8be4` の差分を、ACS の原典（DS5250P・PSNVT5250P・PrintSCS5250・PrintSCS5250DB・NVT5250・
PrintHostData。点検側で PrintSCS5250JPS も取り出した）と突き合わせて読ませた（must 0・should 12・nit 9）。この work に関わる指摘と対応:

- [should][conv:-] `scs.ts` — SI の空白を書くので `FF SI` で終わるジョブに空のページが増える / 対応: SO/SI は位置を進めるだけ（D3）。テスト 1 件
- [should][conv:-] `scs.ts` — 冗長な SO と SBCS の状態の SI が桁を進めない（ACS は毎回進める） / 対応: 毎回進める。テスト 2 件
- [should][conv:-] `spool-html.ts`・`ReportText.vue` — 印の CSS が境目に中心のままで、前の字の右半分に重なる / 対応: 占める桁の中に描く（`ShiftMark.width`）。テスト 2 件
- [should][conv:-] `ReportText.vue` — 破棄した決定を事実として書いたコメント / 対応: 取り消し線で直した
- [nit][conv:-] `scs.ts` — SPCC は ACS では符号付き・ジョブをまたいで残る / 対応: 同じにした。テスト 2 件
- [nit][conv:-] `scs.ts` — SO/SI の空白が重ね打ちの下の字を消す / 対応: 位置を進めるだけにして解消。テスト 1 件
- [nit][conv:-] `README.md` — 救出の説明の「日本語も桁揃えのまま」 / 対応: 1 桁右から始まることを書いた

## ラウンド 3（通過）

対応後の差分を主エージェントが点検。**指摘なし**。mutation（R-a〜R-c・R-h・R-i・R-o・R-p）検出。
