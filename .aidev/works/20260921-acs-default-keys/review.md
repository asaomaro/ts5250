# レビュー: 既定のキー割り当てと End の行き先

## ラウンド 1（通過）
- 指摘なし。独立点検は節目でまとめて行う（PR #410 の方針）。

## ラウンド 2（節目の独立点検・マイルストーン 7。差し戻し）

別コンテキストのエージェントに 5 コミット（`bf04a902` / `ccd59da9` / `7361644e` / `3fda1fb7` / `f623b369`）を、ACS の原典
（`PS5250.processEndField`・`Field5250.getEndPosition`・`FFT5250.getEndPositionOfContField`・`NVT5250.insertVariable`・`AcsMapFunctions.MAP_5250`・
`AutoDeviceName5250`）と突き合わせて読ませた（全体で must 2・should 4・nit 6）。この work に関わる指摘と対応:
- [should][conv:-] `packages/web-ui/src/composables/fieldEdit.ts` `end` — 行をまたぐ欄の 2 行目以降の End が前の行へ戻る（ACS はカーソルの行の先頭を探す下限にする） / 対応: `end(state, from)` に下限を足し、ScreenGrid がスライスの先頭を渡す。ACS のコアで実測して一致（`scripts/acs-probe/end-row-bound.txt`: 2 行目で End → 21,1、1 行目の途中 → 21,3）。research F4 の「無ければ欄の先頭」は取り消し線で直した
- [should][conv:-] `ScreenGrid.vue` End — 継続欄で区切り 1 つの中しか見ない（ACS `getEndPositionOfContField` は最後の区切りから遡る） / 対応: `continuedEnd` を足し、鎖全体で置く（`test/end-key-acs.test.ts`）
- [should][conv:-] `stores/keybindings.ts` × `server/src/tn3270-adapt.ts` — 新しい既定（Esc=Attn・Alt+F1=Help ほか）が汎用機の 3270 で毎回エラーになる / 対応: 3270 の `opened` に `ibmI` を載せ、IBM i 以外では Attn・SysReq・Help・Print の割り当てを送らずに素通しする（`canSendAid`。`test/acs-default-keys-3270.test.ts`）
- [nit][conv:-] `stores/viewSettings.ts:190` — 順送りのキーの記述が古い（ctrl+F3 → ctrl+F1） / 対応: 直した
- [nit][conv:-] `.aidev/backlog/acs-parity.md` — Ctrl+Delete=Erase EOF・Ctrl+Backspace=Erase Input が ACS と食い違う既定として台帳に無い / 対応: MAP_5250 を読み直して（`C127 = [deleteword]`・`C8` 無し・`[eraseeof]` 無し）【まとめ】キー編集の細部に追記
- [nit][conv:-] 確かめられなかった懸念: Safari の IME は確定・取り消しの keydown を isComposing=false・keyCode 229 で送ることがある / 対応: IME の判定に `keyCode === 229` を足した（実ブラウザでは未確認のまま）

## ラウンド 3（通過）

対応後の差分を主エージェントが点検。**指摘なし**。mutation 24 通り（`scratchpad/mut-m7.py`）を当て、1 回目に 2 つ生き残った
（「3270 の `opened` の `ibmI` を状態へ写さない」「交渉の時間切れで接続を閉じない」）——どちらもテストが無かったので
`test/ibmi-3270-opened.test.ts` と `startup-reject.test.ts` の「時間切れのときは接続を閉じる」を足して検出した。全量 6,349 passed / 0 failed / 41 skipped。
