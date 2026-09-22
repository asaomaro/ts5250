# レビュー: 装置名の展開と答え直し

## ラウンド 1（通過）
- 指摘なし。独立点検は節目でまとめて行う（PR #410 の方針）。

## ラウンド 2（節目の独立点検・マイルストーン 7。差し戻し）

別コンテキストのエージェントに 5 コミット（`bf04a902` / `ccd59da9` / `7361644e` / `3fda1fb7` / `f623b369`）を、ACS の原典
（`PS5250.processEndField`・`Field5250.getEndPosition`・`FFT5250.getEndPositionOfContField`・`NVT5250.insertVariable`・`AcsMapFunctions.MAP_5250`・
`AutoDeviceName5250`）と突き合わせて読ませた（全体で must 2・should 4・nit 6）。この work に関わる指摘と対応:
- [must][conv:-] `packages/server/src/session-manager.ts` スプール救出 — 救出が見る OUTQ が設定値の `deviceName`（`PRT%=` のまま・答え直す前の名前）で、使用中の別装置のスプールを保留・削除しうる / 対応: 実際に繋がった装置名（`PrinterSession.deviceName`＝起動応答の装置名、無ければ telnet が送った名前）を使う（`test/rescue-device-name.test.ts`）
- [nit][conv:paired-artifact-sync!] `packages/server/src/ws-handler.ts` WS からのプリンター — `deviceNameRetry` が常駐の経路（`{...t.connect}`）では渡るのに、キーごとの手写しのこちらでは落ちる / 対応: 足した（`test/ws-lifetime.test.ts`）
- [nit][conv:-] `README.md` — 装置名の展開を「種別を問わない」の下に書いていたが、3270・VT は通らない / 対応: 5250（表示・プリンター）だけと書き直した
- [nit][conv:paired-artifact-sync] 確かめられなかった懸念: 8902 で答え直したのにホストが聞き直してこないと 15 秒の時間切れになり、8902 という理由が消える / 対応: 表示・プリンターの両方で、答え直しの最中の時間切れ・切断は 8902 の理由を載せた SESSION_REJECTED にする（成功の起動応答が来たら消す）。あわせて時間切れは close より先に reject する（同期の onClose の文言が勝っていた）

## ラウンド 3（通過）

対応後の差分を主エージェントが点検。**指摘なし**。mutation 24 通り（`scratchpad/mut-m7.py`）を当て、1 回目に 2 つ生き残った
（「3270 の `opened` の `ibmI` を状態へ写さない」「交渉の時間切れで接続を閉じない」）——どちらもテストが無かったので
`test/ibmi-3270-opened.test.ts` と `startup-reject.test.ts` の「時間切れのときは接続を閉じる」を足して検出した。全量 6,349 passed / 0 failed / 41 skipped。
