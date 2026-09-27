# 調査: ホストのエラーの保留の残り

## 判明した事実
- F1（原典 `DS5250.checkContention`）: `ps.getMsgLinePos() != -1` の間、WTD の処理の頭で待つ。WEC（`processWriteErrorCode`）も SysReq の行（`PS5250.processSysReq` の `saveMsgLinePosition`）も同じ位置を立てる。
- F2（実測。2026-09-28・社内機・930。DSM の LATEWTD・`scripts/acs-probe/sysreq-line-hold.txt`）: 画面 → SysReq で行を出す → 8 秒後に 5 行目へ LATE の WTD。ACS のコアは行を出している間 5 行目が空、Reset で閉じると LATE が出た。
- F3（原典 `processCommand`）: `processWCC2` はレコードの終わり（`checkPendingAid` の後）。**実測**（DSM の HOLDCC2・`hold-cc2.txt`）: メッセージ待ちを消してから WTD（CC2＝点ける）＋ 0x21 ＋ WTD の 1 本のレコード。
  ACS のコアは保留の間 mw=false、Reset の後に mw=true。
- F4（原典）: CANCEL INVITE（opcode 0x0A）で `pending_read = 0`。RESTORE（`Save5250Net.restoreNetNulls` → `setPendingReadAndAID`）で `pending_read`・`pending_aid` を戻す。
- F5（当 PJ・直す前）: SysReq の行は画面の側だけでコアは知らない（届いた WTD はすぐ描く）。保留が始まったレコードの CC2 はすぐ効く。CANCEL INVITE・RESTORE は READ の印（`readOutstanding`）に触らない。

## 実装アンカー
- A1: `packages/tn5250/src/session/session.ts`（`holdWtd`・`dismissHostError`・CANCEL INVITE・RESTORE）
- A2: `packages/server/src/ws-messages.ts`・`ws-handler.ts`（`dismiss-host-error` と同じ形）
- A3: `packages/web-ui/src/components/EmulatorPane.vue`（`sysReqOpen` の開閉）
