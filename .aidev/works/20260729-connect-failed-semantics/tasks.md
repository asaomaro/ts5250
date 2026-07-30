# タスク: `CONNECT_FAILED` の意味を取り戻す

- [x] T1: `packages/core/src/errors.ts` — `SESSION_LIMIT` を追加し、**全コードに用途の JSDoc**
      （似ているコードとの使い分けを書く）
- [x] T2: `packages/server/src/host-api.ts` — `statusOf` に `SESSION_LIMIT` → 409（依存: T1）
- [x] T3: `session-manager.ts` の上限 2 箇所を `SESSION_LIMIT` へ（依存: T1）
- [x] T4: `auth.ts` 2 箇所・`config-store.ts` 3 箇所を `CONFIG_ERROR` へ（依存: T1）
- [x] T5: `config-resolver.ts` 2 箇所・`mcp-tools.ts` 2 箇所・`ws-handler.ts` 1 箇所を
      `CONFIG_ERROR` へ（依存: T1）
- [x] T6: `ws-handler.ts` の `fatal` を状態判定（`this.sessionId === undefined`）へ（依存: T5）
- [x] T7: テスト — 写像 / 上限（表示・プリンター）/ 設定系 / 不変条件（server に throw 0 件）/
      `fatal`（依存: T2〜T6）
- [x] T8: 文書 — `.aidev/backlog/library-extraction.md` に結論、`decisions.md`（依存: T7）
