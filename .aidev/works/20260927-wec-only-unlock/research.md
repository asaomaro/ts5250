# 調査: READ の無い WRITE ERROR CODE

## 判明した事実
- F1（原典）: `DS5250.processWriteErrorCode` はエラー状態にしてから `initKeyboard`——エラー状態なら施錠を解き（do-not-enter の表示だけ）、`pending_read` は控えて戻す。
  READ が出ていないときの AID は `pending_aid` に溜まり、次の READ で `checkPendingAid` がそのときの画面で送る。
  `preprocessWCC2` は解錠中（`!WCC2_unlock_pending && locked || kbd_state_chg` でない）の WTD に 0x40（カーソルを動かさない）を足す。
- F2（実測。2026-09-27・社内機・930。DSM の WECONLY・`scripts/acs-probe/wec-only-unlock.txt`）: 画面（5,10 に 10 桁の入力欄）→ 0x21 だけ → 10 秒待つ → READ MDT。
  ACS のコア: 0x21 の後 inhibit=5（エラー状態）・`X` は入らない・Reset で inhibit=0・`AB` を打って Enter の後も inhibit=0。READ MDT は `05 0c f1 11 05 0a c1 c2`（カーソル 5,12・F1・AB）を受けた。
  当 PJ（直す前・`scripts/verify-wec-only-unlock.mjs`）: 施錠のまま・AID は「keyboard is locked」で拒否・READ は何も受けない。
- F4（実測・2 経路目。DSM の WECTWICE・`scripts/acs-probe/wec-twice.txt`。0x21 → 10 秒 → 0x21 → 10 秒 → READ MDT）: 1 回目の窓で Reset → AB → Enter、2 回目の窓で Reset、READ の後に F3。
  ACS のコアの READ は `05 0a 33`（F3）——**2 回目の 0x21 が溜めた Enter を捨てた**（原典 `initKeyboard` の `pending_aid = 0` と一致）。3 回測って同じ。
  ⚠ ACS は F3 に欄（AB）を付けなかった。Enter を押さずに AB だけ打った変形では F3 に AB を付けた（`05 0a 33 11 05 0a c1 c2`）。早い Enter が欄を落とす理由は原典から読めなかった（未確認。台帳に残す）。
  プローブの画面の写し（dump）は入力欄の中身を出さない——欄が空に見えても READ は AB を受けていた（F2）。
- F3: ホストの READ は `04 11 00 08 04 52 00 00`（空の WTD〔CC2 0x08〕＋ READ MDT）で届く。当 PJ はこの WTD の終わりでカーソルを IC（5,10）へ戻す（F1 の 0x40 を入れていない。`wtd-applier.ts` の `placeCursorAfterWtd` の注記と `20260921-cursor-per-wtd-acs` D2）。

## 実装アンカー
- A1: `packages/tn5250/src/session/session.ts` `handleRecord`（READ で ready・`pendingAid` を解く）・`sendAid`・`sendAndWait`
- A2: `packages/tn5250/src/protocol/wtd-applier.ts` `ApplyResult`・`errorCodeWritten`
