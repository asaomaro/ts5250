# レビュー: 欄の外の End

## ラウンド 1（通過）
- 指摘なし。独立点検は節目でまとめて行う（PR #410 の方針）。

## ラウンド 2（節目の独立点検・マイルストーン 7。差し戻し）

別コンテキストのエージェントに 5 コミット（`bf04a902` / `ccd59da9` / `7361644e` / `3fda1fb7` / `f623b369`）を、ACS の原典
（`PS5250.processEndField`・`Field5250.getEndPosition`・`FFT5250.getEndPositionOfContField`・`NVT5250.insertVariable`・`AcsMapFunctions.MAP_5250`・
`AutoDeviceName5250`）と突き合わせて読ませた（全体で must 2・should 4・nit 6）。この work に関わる指摘と対応:
- [must][conv:-] `packages/web-ui/src/components/EmulatorPane.vue` `endKey` — 欄の外の End が合成 End を欄へ投げ返し、欄が処理しない状態（施錠中＋マクロ再生中など）でペインへ伝わって無限に繰り返す / 対応: 合成 End を伝えない（`bubbles: false`。`test/pane-nav.test.ts` に再帰しない例）
- [should][conv:-] 同上 — 継続欄の着地が区切り 1 つの中しか見ない（research F1 は `getEndPositionOfContField` を挙げていたが実装に入っていなかった） / 対応: acs-default-keys と同じ `continuedEnd` を通す
- [nit][conv:-] 同上 — 保護（バイパス）欄の上の End が次の入力欄へ飛ぶ（ACS `FFT5250.getField` は保護欄も返し、その欄の中で末尾へ） / 対応: `endInProtectedField` を足し、その欄の中へ置く（`test/end-key-acs.test.ts`）

## ラウンド 3（通過）

対応後の差分を主エージェントが点検。**指摘なし**。mutation 24 通り（`scratchpad/mut-m7.py`）を当て、1 回目に 2 つ生き残った
（「3270 の `opened` の `ibmI` を状態へ写さない」「交渉の時間切れで接続を閉じない」）——どちらもテストが無かったので
`test/ibmi-3270-opened.test.ts` と `startup-reject.test.ts` の「時間切れのときは接続を閉じる」を足して検出した。全量 6,349 passed / 0 failed / 41 skipped。
