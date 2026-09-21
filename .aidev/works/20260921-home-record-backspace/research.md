# 調査: ACS の Home・Record Backspace・欄データを載せない AID

## 判明した事実
- F1（原典）: `PS5250.processHome`: カーソルが `getHomePos()` なら `processAID(1000)`（`AIDKeyTBL` で 1000 → 248＝0xF8）、そうでなければホーム位置へ
  （DBCS で SO なら +1）、出た欄に `setFieldExitReqFlag(true)`。`homePos` は IC で `setInsertCursor`、書式を消すと 0、カーソルを置く WTD の終わりで
  IC が無ければ `setDefaultInsertCursor`（先頭の非バイパス欄、無ければ 0）。
- F2（原典）: `processAIDCode` は 61・248・243（Help）・189（Clear）で MF・0020・自己点検・ME の検査をしない。`DS5250.sendAid` は 189・108・110・107・243・246・248
  （Clear・PA1〜3・Help・Print・Record Backspace）でカーソルと AID だけを送る（待っている Read がある時だけ）。
- F3（実機・ACS のコア。`scripts/acs-probe/backtab-home.txt`。ADJPGM）: 7,22 で Home → 3,20 ／ 3,20 で Home → 施錠（ホストが「機能キーは使用できません」）／
  1,1 で Home → 3,20。メインメニューのホーム位置で Home → 何も起きない（施錠もしない）。
- F4（実機・ACS のワイヤ。`scripts/tap-proxy.mjs` を挟んで ACS のコアに打たせた。記録はパスワードを含むので解析後に消した）:
  コマンド行に `ABC` を打って Help → `00 0d 12 a0 00 00 04 00 80 03 14 0a f3`（欄データ無し）。ホーム位置で Home → `… 03 14 07 f8`。
- F5（当 PJ）: `AidKey` に Record Backspace が無い（`AID.RECORD_BACKSPACE` の定数だけ）。欄データの門番は `read-response.ts` の `sendsData`（SOH の申告だけ）。
  Home は ScreenGrid（欄内→欄の先頭）とペイン（`focusInput(inputs, 0)`）。送信の合流点（`session-controller.ts` `sendKey`）は Help・Clear を検査から外している。
