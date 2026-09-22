# レビュー: 暗号化した自動サインオン

## ラウンド 1（通過）
- 指摘なし。独立点検は節目でまとめて行う（PR #410 の方針）。

## ラウンド 2（節目の独立点検・マイルストーン 7。差し戻し）

別コンテキストのエージェントに 5 コミット（`bf04a902` / `ccd59da9` / `7361644e` / `3fda1fb7` / `f623b369`）を、ACS の原典
（`PS5250.processEndField`・`Field5250.getEndPosition`・`FFT5250.getEndPositionOfContField`・`NVT5250.insertVariable`・`AcsMapFunctions.MAP_5250`・
`AutoDeviceName5250`）と突き合わせて読ませた（全体で must 2・should 4・nit 6）。この work に関わる指摘と対応:
- [should][conv:-] `packages/tn5250/src/telnet/telnet.ts`・research F2 — 「ACS も計算が例外なら IBMSUBSPW を書かない」は原典と違う（`NVT5250.insertVariable` は `03 名前 01` を switch の前に書く） / 対応: 原典を主エージェントも読み直して確認し、作れないときは IBMRSEED に自分のシード・IBMSUBSPW を値の無いまま送る。research とコメントは取り消し線で直した。実機（PUB400）に値の無い IBMSUBSPW を送らせて、起動応答 `0004`（コード表に無い）のあとサインオン画面になることを確かめた（失敗回数に数えるかは未確認。測った後に成功のサインオンで数え直した）
- [nit][conv:-] `server/src/session-manager.ts` `bypassSubstituteFor` — 計算の失敗（DES で 10 文字超など）を黙って捨て、サインオン画面が出る理由が追えない / 対応: 警告を残して失敗を返す（値はログに出さない。`test/bypass-substitute.test.ts`）

## ラウンド 3（通過）

対応後の差分を主エージェントが点検。**指摘なし**。mutation 24 通り（`scratchpad/mut-m7.py`）を当て、1 回目に 2 つ生き残った
（「3270 の `opened` の `ibmI` を状態へ写さない」「交渉の時間切れで接続を閉じない」）——どちらもテストが無かったので
`test/ibmi-3270-opened.test.ts` と `startup-reject.test.ts` の「時間切れのときは接続を閉じる」を足して検出した。全量 6,349 passed / 0 failed / 41 skipped。
