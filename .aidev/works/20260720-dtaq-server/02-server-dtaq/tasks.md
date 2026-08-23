# タスク: server データ待ち行列（02-server-dtaq）

- [x] T1: `host-connect.ts` に `openDtaq(opts): Promise<DtaqConnection>` を足す（他の open* と同型、
  `hostAuthFrom` を使う）。core の `DtaqConnection` を import。
- [x] T2: `host-dtaq.ts` を新規作成。`registerHostDtaqRoutes(app, deps)` で 6 ルート:
  - `POST /api/host/dtaq/send` `{source, library, name, data, encoding, key?, keyEncoding?}` → `{ok:true}`
  - `POST /api/host/dtaq/receive` `{source, library, name, wait, peek?, key?, search?, encoding?}` → `{entry|null}`
  - `POST /api/host/dtaq/create` `{source, library, name, maxEntryLength, type, keyLength?, saveSender?, description?}` → `{ok:true}`
  - `POST /api/host/dtaq/clear` `{source, library, name, key?}` → `{ok:true}`
  - `POST /api/host/dtaq/delete` `{source, library, name}` → `{ok:true}`
  - `POST /api/host/dtaq/attributes` `{source, library, name}` → `{maxEntryLength, type, keyLength, saveSender}`
  encoding 変換（utf8/base64/ebcdic）、wait クランプ（0〜deps.receiveMaxWaitSec）、`connect?` 注入、
  `withDtaq` 定型（`resolveSource` → open → finally close、`statusOf` でエラー写像）。
  受信の空は `entry:null`、senderInfo は `dtaqDecodeEbcdic` した文字列で返す。
- [x] T3: `app.ts` に `registerHostDtaqRoutes` を登録。`AppDeps` に `dtaqReceiveMaxWaitSec?` を足し、
  `DEFAULT_DTAQ_RECEIVE_MAX_WAIT_SEC = 60` を定義、`limit()` で範囲検査（1〜3600）。
  `main.ts` に CLI 引数（`--dtaq-max-wait` 等）があれば追記（IFS の CLI 引数追加に倣う）。
- [x] T4: `host-server-tools.ts` に MCP ツールを足す:
  `host_dtaq_send` / `host_dtaq_receive` / `host_dtaq_create` / `host_dtaq_clear` /
  `host_dtaq_delete` / `host_dtaq_attributes`。`withAudit` / `target` / `openDtaq` / `jsonResult` / `errorResult`。
- [x] T5: ユニットテスト `test/host-dtaq.test.ts`（`buildApp()` + `app.request()`、偽 `connect`）:
  入力検証（zod strict・wait 範囲・encoding enum）、ステータス写像（NOT_FOUND→404 等）、
  encoding 往復（utf8/base64/ebcdic）、受信の空→`entry:null`、senderInfo デコード。
  MCP ツールの入出力スキーマも軽く固定。
- [x] T6: 実機 curl で 6 ルートを検証（PUB400/TESTLIB）。QSYS2 の SQL サービス
  （`DATA_QUEUE_ENTRIES` / `DATA_QUEUE_INFO`）と突き合わせ。都度片付ける。
  `npm run -w @as400web/server test` と lint / build がクリーン。
