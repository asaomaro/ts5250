# タスク: web-ui データ待ち行列（03-web-ui-dtaq）

- [x] T1: `dtaqApi.ts` を新規作成（`ifsApi.ts` を手本）:
  - `post(route, body)` で `/api/host/dtaq/*` を叩く。`!res.ok` は `DtaqRequestError` を投げる
  - `messageFor(body)` で code→日本語文言（NOT_FOUND/ACCESS_DENIED/ALREADY_EXISTS/CONFIG_ERROR/…）、
    `KNOWN_ERROR_CODES` をテスト網羅用に export
  - 関数: `send` / `receive` / `create` / `clear` / `deleteQueue` / `attributes`
  - `listEntries(source, library, name)`: `/api/host/sql` に `DATA_QUEUE_ENTRIES` の SELECT を投げる
  - **名前検証** `assertObjectName`（`/^[A-Z0-9$#@_.]{1,10}$/i`）。SQL に埋める前に必ず通す（インジェクション対策）
- [x] T2: `components/DtaqPane.vue` を新規作成（`defineProps<{ tabId }>`、パネルローカル状態）:
  - キュー指定（library/name）、属性表示、エントリ一覧（position/bytes/EBCDIC text/hex/timestamp/sender）、
    送信フォーム（data + encoding + key?）、受信/ピーク（encoding）、クリア/削除/作成
  - `useDelayedLoading` で busy/slowLoading、エラーは `DtaqRequestError.message` を表示
  - CCSID の限界（一覧 text は EBCDIC 解釈）を UI に注記
- [x] T3: パネル登録 4 箇所:
  - `paneLabels.ts`: `PANE_PREFIXES` に `"dtaq:"`、`PANE_LABELS` に `"dtaq:entries": "データ待ち行列"`
  - `WorkspaceNode.vue`: import・`activeIsDtaq` computed・テンプレート分岐
  - `LauncherPane.vue`: `FEATURES` に `{ id: "dtaq:entries", name: "データ待ち行列", desc: … }`
- [x] T4: ユニットテスト:
  - `test/dtaq-api.test.ts`: 名前検証、messageFor が KNOWN_ERROR_CODES を網羅、fetch 差し替えで各関数
  - `test/dtaq-pane.test.ts`: mount + `globalThis.fetch` 差し替えで送信・受信・一覧・属性・エラー表示・
    無効な名前を弾く
- [x] T5: 実ブラウザ E2E（既存の E2E 手順に倣う）で送受信・一覧・属性を通し確認。
  `npm run -w @as400web/web-ui test`・lint・vue-tsc・build がクリーン。
