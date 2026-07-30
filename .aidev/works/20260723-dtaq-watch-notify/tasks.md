# タスク: データ待ち行列の常駐監視と到着通知

## A 群: サーバー（常駐レジストリと契約）

- [x] A1: `core/src/transport/host-connection.ts` に `setKeepAlive(true, 60_000)`
- [x] A2: `config-types.ts` — `sessionTypeSchema` に `dtaqwatch` / `dtaqWatchSchema` /
      `sessionBase.dtaqWatch` / `PublicSession.dtaqWatch` / **種別と設定の整合を parse で強制**
- [x] A3: `config-store.ts` の `publicSession()` で `dtaqWatch` を転記（依存: A2）
- [x] A4: `watch-registry.ts`（新規）— 開始・停止・一覧・履歴・購読・再接続・上限・所有者
      （依存: A2）
- [x] A5: `ws-messages.ts` — `watch-*`（client 4・server 4）（依存: A4）
- [x] A6: `ws-handler.ts` — `watch-subscribe` / `watch-start` / `watch-stop` / `watch-history`。
      **`dispose` はレジストリに触らない**（依存: A5）
- [x] A7: `app.ts` で `WatchRegistry` を生成して渡す / `main.ts` に `--max-watches` /
      `index.ts` で公開（依存: A6）
- [x] A8: server テスト（`watch-registry` / `config-types` / `ws-handler`）（依存: A7）

## B 群: web-ui（監視コンソール）

- [x] B1: `stores/watches.ts`（新規）— 一覧・履歴・未読・`markRead`（依存: A5）
- [x] B2: `WatchPane.vue`（新規）— 一覧・履歴・停止・**消費の注意文**（依存: B1）
- [x] B3: `paneLabels.ts` に `watch:` / `PaneTabs.vue` の pane タブ未読 /
      `WorkspaceNode.vue` の描画（依存: B2）
- [x] B4: `LauncherPane.vue` — `dtaqwatch` の接続＝監視開始（装置名分岐を通さない）/
      `ConfigCard.vue` — 種別と監視設定の編集（依存: A3, B3）
- [x] B5: web-ui テスト（`stores/watches` / `WatchPane` / `PaneTabs` / `LauncherPane`）（依存: B4）

## C 群: 検証と文書

- [x] C1: 実機検証 — `probe-dtaq-longwait.mjs`（長時間アイドル）と
      `verify-browser-watch.mjs`（新規。監視 → 到着 → 未読 → 停止）（依存: A8, B5）
- [x] C2: 空振り検証（`dispose` で止める / 停止フラグ / 履歴上限 / 所有者 /
      `requireSession` / 権限エラーの再試行）（依存: C1）
- [x] C3: 文書 — `scripts/README.md` に 2 本、`README.md` に `--max-watches`、
      `decisions.md`、backlog（`hostserver.md` の常駐化項目に「一般形は入った」を追記）（依存: C2）
