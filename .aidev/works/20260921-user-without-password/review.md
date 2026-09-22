# レビュー: USER の条件

## ラウンド 1（通過）
- 指摘なし。独立点検は節目でまとめて行う（PR #410 の方針）。

## ラウンド 2（節目の独立点検・マイルストーン 7。差し戻し）

別コンテキストのエージェントに 5 コミット（`bf04a902` / `ccd59da9` / `7361644e` / `3fda1fb7` / `f623b369`）を、ACS の原典
（`PS5250.processEndField`・`Field5250.getEndPosition`・`FFT5250.getEndPositionOfContField`・`NVT5250.insertVariable`・`AcsMapFunctions.MAP_5250`・
`AutoDeviceName5250`）と突き合わせて読ませた（全体で must 2・should 4・nit 6）。この work に関わる指摘と対応:
- [nit][conv:-] `packages/tn5250/src/telnet/telnet.ts` — 空白だけのパスワードで USER と代替パスワードを送る（ACS は末尾の空白を落として空なら自動サインオンをやめる） / 対応: 末尾の空白を落としてから空かを見る（`test/telnet.test.ts`）

## ラウンド 3（通過）

対応後の差分を主エージェントが点検。**指摘なし**。mutation 24 通り（`scratchpad/mut-m7.py`）を当て、1 回目に 2 つ生き残った
（「3270 の `opened` の `ibmI` を状態へ写さない」「交渉の時間切れで接続を閉じない」）——どちらもテストが無かったので
`test/ibmi-3270-opened.test.ts` と `startup-reject.test.ts` の「時間切れのときは接続を閉じる」を足して検出した。全量 6,349 passed / 0 failed / 41 skipped。
