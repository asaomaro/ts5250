# 調査: ホストのエラーの間の WTD の保留

## 調査の問い
- Q1: ACS の仕組み（`20260927-error-msgline-wtd` research F2 の要点）
- Q2: 当 PJ のエラー状態の置き場と、抜ける経路

## 判明した事実
- F1（Q1・原典。`20260927-error-msgline-wtd` research F1・F2）: `DS5250.checkContention` は WTD の頭で `MsgLinePos != -1` の間止まる。止まるのはデータ処理のスレッドなので後ろのレコードも並ぶ。
  RESTORE・CLEAR UNIT・SAVE・READ・WSF・WEC は止めない（CLEAR UNIT・SAVE はエラー状態を解く）。抜ける契機はエラー中のキー（編集系を除く）・Reset・Help の AID・メッセージ行のクリック・CLEAR UNIT・SAVE。
- F2（Q2・コード）: エラー状態は web-ui の側（`EmulatorPane.vue` の `hostErrorActive`＝`systemMessageSeq` が `hostErrorDismissedSeq` と違う）で、抜けると `exitErrorMode` がメッセージを隠す。
  core は `systemMessage` を WEC で立て、CLEAR UNIT・SAVE・メッセージ行への書き込みで捨てる（`packages/tn5250/src/screen/buffer.ts`）。**抜けたことは server・core に伝わっていない**。
  エラー中の AID は、画面の側が抜けてからキーを送る（`onKeydownCapture`）。
- F3（Q2・コード）: レコードの処理は `Session5250.handleRecord` が `applyDataStream` の結果を後段で使う。読むのはオペコードとデータだけ（`parsed.opcode` / `parsed.data`）——止めた後ろを同じオペコードのレコードに組み直して流し直せる。

## 影響範囲
- `packages/tn5250/src/protocol/wtd-applier.ts`・`packages/tn5250/src/session/session.ts`・`packages/server/src/ws-messages.ts`・`packages/server/src/ws-handler.ts`・`packages/web-ui/src/components/EmulatorPane.vue`

## 実現性 / リスク
- 抜ける知らせが届かないと画面が止まったままになる——AID でも抜ける（core）ので MCP でも止まらない。古いクライアントは知らせないが、AID で抜ける。

## 実装アンカー
- A1: `applyDataStream` の WTD（`wtd-applier.ts`）
- A2: `Session5250.handleRecord`・`sendAid`（`session.ts`）
- A3: `exitErrorMode`（`EmulatorPane.vue`）・`WsHandler.handle`（`ws-handler.ts`）

## design への申し送り
- SysReq の行の間の保留は backlog に残す
