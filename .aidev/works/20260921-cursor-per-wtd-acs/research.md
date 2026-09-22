# 調査: カーソルの初期位置（ACS との突き合わせ）

## 判明した事実
- F1（原典 `DS5250`）: `processCommand` はレコードの頭で `kbd_state_chg = false; pendingCCbyte2 = 0`。WTD は `processWCC1` → オーダー →
  `preprocessWCC2(cc2)`。`preprocessWCC2` は CC2 の 0x40 を持ち越し、動かしてよければ `WTD_IC_addr`（無ければ `setDefaultInsertCursor`＝
  最初の非 bypass 欄、無ければ 0）、MC があれば MC へ置く。動かさない指定でも MC は効く。IC（0x13）は MC を捨てる。
  `WTD_IC_addr` / `WTD_MC_addr` は `processClearFMT`（CLEAR UNIT・CLEAR FORMAT TABLE・SOH）でだけ捨てる＝**レコードをまたいで持ち越す**。
  READ INPUT / MDT / MDT ALT は `pending_read` と CC を覚えるだけで、カーソルに触れない。
- F2（原典）: `preprocessWCC2` の頭に「`!(!WCC2_unlock_pending && isKeyboardLocked() || kbd_state_chg)` なら 0x40 を足す」がある
  （解錠中に来てキーボードの状態を変えない WTD は動かさない、と読める）。
- F3（実機・分かれたレコード）: SNDF → RCVF は「CLEAR UNIT ＋ WTD」と「READ MDT」を別のレコードで送る（トレースで確認）。
  ACS は IC あり 7,20・IC なし 5,20。当 PJ は IC ありでも 5,20（READ で先頭の入力欄へ動かしていた）。
- F4（実機・9 画面。`scripts/acs-probe/cursor-screens.txt` と `scripts/verify-cursor-screens.mjs`）: ACS はメインメニュー 20,7・
  DSPFMT 7,4・DSPFMT の後 20,7・WRKOBJ 8,2・SNDMSG のプロンプト 5,37・WRKSPLF 3,21・SPLIT 7,20・SPLITN 5,20・窓 9,13。
- F5（実機・DSPFMT）: 応答は 3 レコード——「CLEAR ＋ WTD（CC2 0x28・SOH）」×2（出力だけ）と「WTD（CC1 0・CC2 0x28・SOH なし・IC 7,4）＋ READ」。
  中継（`scripts/tap-proxy.mjs`）で採った ACS 側のレコードも同じ形だった。F2 を素直に当てると 3 つ目の WTD では動かないはずだが、
  **ACS は 7,4 に置いた**。ACS がレコードの終わりにキーボードを開く時機の読みが確かめられていない。

## 実装アンカー
- A1: `packages/tn5250/src/protocol/wtd-applier.ts`（IC / MC・SOH・クリア・WTD の終わり）
- A2: `packages/tn5250/src/screen/buffer.ts`（IC / MC の番地・ホーム）
- A3: `packages/tn5250/src/session/session.ts`（READ のときの先頭の入力欄）
