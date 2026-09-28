# 調査: 1 本のレコードの中の応答の順

## 判明した事実
- F1（実機・ACS のコア・2026-09-28。DSM の RESPORDER / RESPORDER2・`scripts/acs-probe/response-order.txt`・`relay-5250.mjs` のワイヤ）:
  - RESPORDER: ホスト → 端末 `12a0 0000 0400 0003 | 04 f3 0005d97000 04 02`（オペコード 03・[WSF Query][SAVE SCREEN]）。ACS は **Query の応答（`…8003 0000 88 0044 d970…`）→ 退避の応答（`…8003 0412 789c…`）** の順に 2 本。
  - RESPORDER2: `12a0 0000 0400 0004 | 04 02 04 f3 0005d97000`（オペコード 04・[SAVE SCREEN][WSF Query]）。ACS は **退避の応答（`…8004 0412…`）だけ**を返し、Query には答えなかった（DSM の 2 回目の読みは CPFA306）。
- F2（原典 `DS5250.tokenizeData` の case 4・`processCommand`）: オペコード 4 でデータが `04 02` で始まり長さが 4 以上なら `processSaveScreen()` だけを呼んでレコードの残りを読まない。ほかは `processCommand` がコマンドを順に処理し、SAVE・WSF・READ SCREEN 系の応答をその場で送る（否定応答だけはレコードの終わり）。
- F3（当 PJ）: `packages/tn5250/src/session/session.ts` の受信の処理は `applyDataStream` の後、`saveRequests` → `wsfReplies` → READ SCREEN EXTENDED → READ IMMEDIATE → READ MDT IMMEDIATE ALT → READ SCREEN の固定の順に送る（コメントに「コマンド順は追わず」と明記）。`streamOf` はオペコード 4 をそのまま全部読む。

## 実装アンカー
- A1: `packages/tn5250/src/protocol/wtd-applier.ts` の `ApplyResult`（応答の種類の順を足す）と各 case
- A2: `packages/tn5250/src/session/session.ts` の受信の処理（`saveRequests` の送信〜`sendNegative()`）と `streamOf`
