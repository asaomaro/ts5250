# タスク: pull 型スプール取得の Web UI 対応

依存順に直列。上の層は下の層が緑になってから着手する。

## core

- [x] **T1**: `listSpooledFiles` の戻りを `SpoolListResult { entries, total }` に変更（依存: なし）
  - `spool-list.ts:200` 付近で `LIST_INFO.total`（offset 0）を読む
  - `SpoolListResult` を定義し `packages/core/src/index.ts:153` の export に追加
  - `total` の JSDoc に「`max` で切る前の総件数。打ち切り判定に使う」と書く
  - コメントは why 中心＋`spec 方針5` を参照（AGENTS.md コメント規約）

- [x] **T2**: `packages/core/test/spool-list.test.ts` を追従（依存: T1）
  - 既存テストを新シグネチャ（`.entries`）に修正
  - **`returned < total` の応答**を用意し `total` が正しく読めることを確認（R1 の固め）

## server

- [x] **T3**: `packages/server/src/host-spools.ts` に共有関数を新規作成（依存: T1）
  - 定数 `DEFAULT_SPOOLS = 100` / `MAX_SPOOLS = 1000` / `DEFAULT_SPOOL_CCSID = 273`
  - `listSpools(opts, filter, max)` → `{ items, total, truncated }`（`truncated = total > items.length`）
  - `readSpoolPages(opts, id, ccsid?)` → `LogicalPage[]`
  - 両関数とも `try { … } finally { conn.close() }`（`host-connect.ts:7-9` の義務）
  - **`max` の上限検査を関数内にも置く**——MCP 経路は zod を通らないため（`host-upload.ts:96-98` と同じ理由をコメントに書く）
  - ログは `childLog({ component: "host-spools" })`。`console.*` は使わない

- [x] **T5**: `spoolCcsid` を config スキーマから resolver まで通す（依存: なし）
  - `config-types.ts` `systemSchema` に `spoolCcsid: z.number().int().optional()`
  - `PublicSystem` に `spoolCcsid?: number`
  - `config-routes.ts:73` `toSystemRecord` の whitelist に追加
  - `config-store.ts`（`:146` / `:163` 付近）の公開形に転記
  - `config-resolver.ts` で `ConnectOptions` へ転記（既存 `ccsid` とは**別の項目**として扱う）
  - **信頼設定ではない**ので `printer` のようなサーバー設定限定ゲートは付けない（spec 方針2 / AGENTS.md §6）

- [x] **T4**: HTTP ルート 3 本＋登録（依存: T3, T5）
  - `POST /api/host/spools` → `{ items, count, total, truncated }`
  - `POST /api/host/spool/content` → `{ pages }`
  - `POST /api/host/spool/pdf` → `application/pdf`（`renderSpoolPdf` をそのまま呼ぶ）
  - zod は全て `.strict()`。`source` は既存 `sourceSchema` を再利用
  - **資格情報は body に載せない**——`resolveSource(deps.resolver, body.source, c.get("user"))`
  - エラーは `statusOf(err)` で写像（独自写像を作らない）
  - PDF の `Content-Disposition` の `fileName` は**サニタイズしてから埋める**（既存 `app.ts:126` の粗さを繰り返さない）
  - `renderSpoolPdf` の `warn` を `childLog` に配線（R5）
  - `app.ts` に `registerHostSpoolRoutes(app, deps)` を登録

- [x] **T6**: MCP スプールツールを共有関数へ寄せる（依存: T3）
  - `host-server-tools.ts` の `host_list_spools` / `host_get_spool` が `host-spools.ts` を呼ぶ
  - **入出力スキーマは変更しない**（`host_list_spools` は `{ items, count }` のまま）
  - `total` の MCP 公開はスコープ外（別課題）

## web-ui

- [x] **T7**: `SpoolPane.vue` を新規作成（依存: T4）
  - 骨格は `HostListPane.vue`（`tabId` prop / `useDelayedLoading` / `error` / `systemsStore.selected`）
  - 絞り込み 6 項目（user / outputQueue / outputQueueLibrary / status / formType / userData）
  - `user` は空欄＝自分（`*CURRENT`）とプレースホルダで明示
  - 未選択ガード「システムを選んでください」
  - `truncated` 時に「{total} 件中 {count} 件を表示しています」
  - 本文は `<pre>`。複数ページは `PrinterPane.vue:119-124` と同じ改ページ区切りで連結
  - PDF は fetch(POST) → blob → `<a download>` → revoke。**`!res.ok` を握り潰さない**
  - 表は `SqlPane.vue` の `useColumnWidths()` を再利用
  - **ペイン自体をスクロールさせない**（根を `flex-direction: column`、内側 1 枚に閉じる）
  - sticky `th` に背景 `--card` 必須、罫線は `box-shadow: inset 0 -1px 0 var(--line)`
  - 配色は CSS 変数のみ（生色禁止）。light / dark 両方で確認

- [x] **T8**: ペイン登録 5 箇所（依存: T7）— **漏れは既知のバグ源**（`paneLabels.ts:5-7`）
  - [x] `paneLabels.ts:11` `PANE_PREFIXES` に `"spool:"`
  - [x] `paneLabels.ts:19-28` `PANE_LABELS["spool:files"] = "スプール"`
  - [x] `WorkspaceNode.vue` `activeIsSpool` computed ＋ `v-else-if` 分岐 ＋ import
  - [x] `LauncherPane.vue:39-49` `FEATURES` に追加（desc で push 型と区別）
  - [x] `PaneTabs.vue` / `App.vue` が `PANE_LABELS` / `isPaneTab` 経由で追従することを確認

- [x] **T9**: `ConfigCard.vue` にスプール CCSID（依存: T5）
  - システム編集フォームに「スプール CCSID」を追加（既定 **273**。`DEFAULT_CCSID`＝37 とは別）
  - 選択肢は `hostCodePages.ts` の `HOST_CODE_PAGES` を再利用
  - `stores/systems.ts` の `SystemForm` に `spoolCcsid?: number`
  - ラベル脇に「5250 画面の CCSID とは別」と分かる補足を置く

## 検証

- [x] **T10**: テスト（依存: T2, T6, T8, T9）
  - ユニット（server）: `truncated` 境界（`total == max` は偽 / `total > max` は真）、
    上限超過で `CONFIG_ERROR`、CCSID 引き回し
  - 設定: `spoolCcsid` がスキーマ → resolver → `openNetPrint` まで届く（R2 の転記漏れ対策）
  - コンポーネント: `SpoolPane` の未選択ガード・エラー表示・`truncated` 表示・改ページ連結
  - 回帰: 既存 MCP スプールツール、`PrinterPane`、既存 PDF ルート
  - ビルド: `npm run build -w @as400web/web-ui`（**vue-tsc を必ず通す**）
  - web-ui テストは `cd packages/web-ui && npx vitest run`（ルートからは実行しない）

- [ ] **T11**: 実機確認（PUB400）（依存: T10）
  - USER 所有の OUTQ を作ってスプールを用意（特殊権限 `*NONE` のため。`CPF3464` 回避）
  - 一覧 → テキスト → PDF を通す
  - **`total` の実値が期待どおりか**を確認（R1。ここが未検証の核心）
  - PDF を開いて DBCS が化けていないか目視（R5）
  - **「見込み」で終わらせない**（AGENTS.md「実機検証を単体テストの代替にしない」）
