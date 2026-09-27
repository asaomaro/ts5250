# 調査: 解錠中の WTD と溜めた AID のカーソル

## 判明した事実
- F1（原典）: `DS5250.preprocessWCC2` の頭で、`!(!WCC2_unlock_pending && locked || kbd_state_chg)` なら CC2 に 0x40（動かさない）を足す。`processWCC1` は CC1 が 0 なら `kbd_state_chg = false`、
  それ以外なら `pending_aid = 0` と施錠。`checkPendingAid` はレコードの終わり（`processCommand` の最後）。ヘッダのオペコード 1・3 で `pending_read` を立てる。
- F2（実測。2026-09-27・社内機・930。DSM の UNLOCKWTD / UNLOCKWTDNOIC / UNLOCKWTDCC1・`scripts/acs-probe/unlocked-wtd-cursor.txt`）: 1 本目（出力だけ・CC2 0x08 で解錠・IC 5,10）→ カーソルを 9,2 へ → 6 秒後に 2 本目（WTD＋READ）。
  ACS のコア: IC 7,10 の WTD → 7,10、IC の無い WTD → 5,10、CC1 0x20 と IC 7,10 → 7,10。**解錠中でも動く**（F1 の条件どおりには動かない。`20260921-cursor-per-wtd-acs` の DSPFMT と同じ）。
  各モード 1 回。当 PJ（`scripts/verify-unlocked-wtd-cursor.mjs`）も IC 7,10 の 2 通りは 7,10 に置いた——**(f) は差ではなかった**。ただし当 PJ の検証は「利用者が 9,2 へ動かした」を
  再現していない（コアにカーソルを動かす口が無く、画面の側のキャレットの話になる）ので、IC の無い UNLOCKWTDNOIC の 5,10 は動いたかを区別しない。
- F3（実測。DSM の WECONLYW・`tap-proxy` のワイヤ）: 0x21 だけの後に Reset → AB → Enter。READ のレコード（オペコード 3・`WTD 11,2 NEXT`・`WTD CC1 0x20 CC2 0x08`・`WTD CC2 0x08`・READ MDT。IC なし）が来た**後に**、
  ACS は `05 0c f1 11 05 0a c1 c2`（押したときのカーソル 5,12・AB）を送った。CC1 0x20 の WTD でも捨てず（F1 の `pending_aid = 0` と合わない）、カーソルも動かさない。先打ち（押したキーを溜めて解錠で流す）に近い。
  測ったのは 1 回（CC1 0x20 の 1 通り）。当 PJ（`20260927-wec-only-unlock` の直後）: CC1 の施錠で溜めを捨て、READ に何も返さずホストが待ち続けた。WECONLY でも READ の前の WTD がカーソルを IC へ戻して 5,10 を送っていた。
- F4: WECTWICE（2 回目の 0x21 の後の Reset）では ACS も溜めを捨てた（`20260927-wec-only-unlock` research F4）。Reset が先打ちを捨てるのと矛盾しない。

## 実装アンカー
- A1: `packages/tn5250/src/session/session.ts` の `deferredAid`（押したときのカーソル・CC1 で捨てない）
