# タスク: セッションの寿命（アイドルタイムアウト・永続）

- [x] T1: `session-manager.ts` — `idleTimeoutMs` を `number | "never"` に（既定 `"never"`）、
      `OpenOptions` / `OpenPrinterOptions` / `SessionEntry` / `PrinterEntry` に追加、
      `sweepIdle()` をエントリ毎判定に、`touch()` と `orphanSafeIdleTimeoutMs()` を追加
- [x] T2: `config-types.ts` — `idleTimeoutSchema` / `IdleTimeout` / `sessionBase.idleTimeout` /
      `idleTimeoutToMs()` / `PublicSession.idleTimeout`（依存: T1）
- [x] T3: `config-resolver.ts` で `connect.idleTimeoutMs` を載せる ＋ `config-store.ts` の
      `publicSession()` で転記（依存: T2）
- [x] T4: `ws-messages.ts` — `WsActivity` / `WsPong` / `WsPing` を追加し union に入れる（依存: T1）
- [x] T5: `ws-handler.ts` — display / printer 両方で `idleTimeoutMs` 転記、`activity` / `pong` 受信、
      ハートビート（開始・死判定・停止）（依存: T3, T4）
- [x] T6: `mcp-tools.ts` — `open_session` とプリンターの 2 か所で `orphanSafeIdleTimeoutMs()` を通す
      （依存: T1, T3）
- [x] T7: `main.ts` — `--idle-timeout <分|never>` を追加し `SessionManager` へ渡す（依存: T1）
- [x] T8: サーバー側テスト（`session-manager` / `config-types` / `config-resolver` / `ws-handler` /
      `parseArgs`）（依存: T5, T6, T7）
- [x] T9: `ws-client.ts` — `ping` に自動 `pong`、`activity` / `ping` / `pong` を操作ログに出さない（依存: T4）
- [x] T10: `session-controller.ts` — `noteActivity()`（15 秒の間引き）（依存: T9）
- [x] T11: `EmulatorPane.vue` — `onEdit` / `onCursor` から `noteActivity()`（依存: T10）
- [x] T12: web-ui 設定 UI — `stores/systems.ts` の `SessionConfigForm` ＋ `ConfigCard.vue`
      （フォーム初期値・読み込み・保存・概要行・select）（依存: T3）
- [x] T13: web-ui テスト（`noteActivity` の間引き / `pong` 自動応答 / ログに出ない /
      `EmulatorPane` から出る / `ConfigCard` の往復）（依存: T11, T12）
- [x] T14: 文書 — `README.md` の CLI 表、`.aidev/backlog/session-lifetime.md` の全項目に結論、
      `decisions.md`（依存: T8, T13）
