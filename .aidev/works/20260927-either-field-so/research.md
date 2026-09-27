# 調査: 空にした E 欄

## 判明した事実
- F1: 実機の ACS のコア（DSM の READDBCS の E 欄 17,10 `SO あ SI`。`scripts/acs-probe/either-empty.txt`・`either-switch-empty.txt`。2 回）: SO の直後から Erase EOF した欄は `0e`、先頭に X を打って半角へ切り替えてから Erase EOF した欄は何も送らない（SBA だけ）
- F2: 当 PJ の E 欄の状態は画面（`ScreenGrid.vue` の `eitherDbcsOn`・`eitherSwitched`）とコア（`InternalField.eitherDbcsOn`・`noteEitherMode`）に分かれ、送る値は論理値の文字列だけ（ws の `fields[].value`）。コアは空の値で状態を変えない
- F3: 画面の編集は E 欄も含めて DBCS の欄はすべて `syncDbcs` の `emit("edit", …)` を通る（`isDbcsEdit`）。`edits` は表示にも使う（`logicalValue`）ので、値そのものに印を混ぜると表示が化ける
- F4: SO の構造の桁（`charKind: "so"`）は `hasDbcsStructure` → `dbcsRawCells` で送信され、末尾の NUL を落とすと `0e` になる（`20260927-read-dbcs-fields`）

## 実装アンカー
- A1: `packages/web-ui/src/components/ScreenGrid.vue` `syncDbcs`・`EmulatorPane.vue` `onEdit`・`session-controller.ts` `sendKey`・`stores/sessions.ts`
- A2: `packages/server/src/ws-messages.ts` `WsKeyField`・`ws-handler.ts` `resolveField`
- A3: `packages/tn5250/src/session/session.ts` `setField`・`screen/buffer.ts` `setFieldValue`
