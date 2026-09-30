# 調査: 中身が入って届く伏せ字の DBCS 欄の編集

## 判明した事実
- F1（実機。`hidden-dbcs-content.txt`・DSM の HIDDENC・2026-10-01）: 非表示の O（`SO あ い SI`＋NUL）の あ へ う を上書き → `0e 4483 4482 0f`・Delete → `0e 4482 0f`。J（ホストが欄長へ整えた `SO あ い 4040×3 SI`）は上書き `0e 4483 4482 4040×3 0f`・Delete `0e 4482 4040×… 0f`。E は O と同じ
- F2（コード）: snapshot は非表示のセルの字を空白にし（`buffer.ts` の `snapshot`）、`Field.value` は空。web-ui の DBCS 欄の編集は空から始まり、保存は欄全体を置き換えていた
- F3（コード）: ws の保存は `Session5250.setField` の 1 か所（`ws-handler.ts`）。MCP・マクロも同じ入口

## 影響範囲
- core: `buffer.ts`（snapshot・`mergeKeep`）・`types.ts`・`attr-sentinel.ts`・`session.ts`、web-ui: `ScreenGrid.vue` の `logicalFromCells`

## 実装アンカー
- A1: `buffer.ts` `snapshot` のセル・`mergeKeep`
- A2: `session.ts` `setField`

## design への申し送り
- 触らない桁は目印（桁の番号つき）で値に載せ、保存の入口で core が元の中身へ戻す
