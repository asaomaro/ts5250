# 調査: その場で戻る否定応答と CC2

## 調査の問い
- Q1: ACS はどの否定応答でその場で戻り、何を飛ばすか（原典）
- Q2: 実機で、WTD（CC2）＋不正な ROLL の 1 レコードに ACS のコアと当 PJ はどうするか

## 判明した事実
- F1（Q1・原典 `DS5250.processCommand`）: 先頭で `pendingCCbyte2`・`isPrepwcc2` を捨て、ループの後の尾部で `processWCC2(pendingCCbyte2)`（警報・メッセージ待ち）と SAVE PARTIAL の応答（`bSavePartial`）を送る。
  WTD / READ の CC2 は `preprocessWCC2` で溜めるだけ。次の 8 か所は `return` で尾部を飛ばす: ESC が無い（0x10050121）・CLEAR UNIT ALTERNATE の長さ不足（否定応答なし）と引数が 0 でない（0x10030101）・
  ROLL の長さ不足（0x10050121）と指定の不正（0x1005012C）・WRITE ERROR CODE の本体が無い（0x10050121）・WTD の CC が無い（0x10050121）・READ の CC が無い（0x10050121）・WSF の長さ不足（0x10050121）。
  WSF D9/72 のフラグ・WTD の中の誤りは `sense_code` を立ててループの条件で抜けるので尾部は走る。`bSavePartial` は先頭で捨てないので、戻ったレコードの SAVE PARTIAL の応答は次のレコードの尾部で送られる。
- F2（Q2・実測。2026-09-27・社内機）: DSM（`scripts/host-src/dscmd.c` の EARLYROLL。コマンド・バッファで 1 レコードにまとめる）で「WTD（CC2＝0x01）＋不正な ROLL（上端 10・下端 5）」を出させた。
  前に点いていたメッセージ待ちを先に消し（CC2＝0x02 の WTD）、レコードの後 8 秒待って見た。**ACS のコア: mw=false（点かない）**・画面の 5 行目に EARLY ROLL。
  **当 PJ（直す前）: mw=true（点く）**・EARLY ROLL・否定応答 0x1005012C（`scripts/acs-probe/early-return-cc2.txt`・`scripts/verify-early-return-cc2.mjs`）。
  否定応答を受けたホストは、次の出力を CPFA303 / 次の入力を CPFA304 で返す（DSM のログ）。
- F3（Q2・実測。直した後）: 当 PJ も mw=false（`verify-early-return-cc2.mjs` pass=4）。

## 影響範囲
- `packages/tn5250/src/protocol/wtd-applier.ts` の否定応答の 4 か所（ESC が無い・CLEAR UNIT ALTERNATE・ROLL・WSF が短い）

## 実現性 / リスク
- 画面への書き込みは ACS も残す（F2）ので、落とすのは結果の警報・メッセージ待ちだけ。

## 実装アンカー
- A1: `applyDataStream` の主ループの否定応答（`wtd-applier.ts`）

## design への申し送り
- SAVE PARTIAL の持ち越し・READ の解錠・当 PJ が否定応答にしていない短いレコードは backlog に残す。
