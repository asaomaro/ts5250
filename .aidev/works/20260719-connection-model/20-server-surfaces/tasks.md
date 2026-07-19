# タスク: 20-server-surfaces

- [x] T1: `main.ts` / `app.ts` — `ServerConfigStore` / `PersonalConfigStore` / `ConfigResolver` を
      組み立てて依存として配る。`canEditProfiles` 相当の判定を新ストアに合わせる
- [x] T2: REST — `/api/systems` `/api/sessions` の CRUD を新設。旧 `/api/profiles` `/api/connections`
      を置換。**信頼境界 2〜4 層目（admin ゲート・display 破棄・`validatePrinter`）を移し替える**（依存: T1）
- [x] T3: `ws-messages.ts` / `ws-handler.ts` — `open` を `system` / `session` 参照に。
      `warn` を `ConfigResolver` へ配線（依存: T1）
- [x] T4: `mcp-tools.ts` — `open_session` / `open_printer_session` / `signon` の引数を置換。
      `list_connections` を `list_systems` / `list_session_configs` に。
      **`open_printer_session` の deviceName バグを直す**（依存: T1）
- [x] T5: `host-lists.ts` — `sourceSchema` を `system` 参照に。`warn` を配線（依存: T1）
- [x] T6: 旧 `profiles.ts` / `connection-store.ts` と、それらを対象にした旧テストを削除（依存: T2-T5）
- [x] T7: REST・WS・MCP のテストを新モデルへ書き換え。信頼境界 2〜4 層目の確認を含む（依存: T6）
- [x] T8: `scripts/verify-mcp.mjs` / `scripts/verify-ws.mjs` の引数更新（依存: T4, T3）
- [x] T9: ドキュメント更新（README の「セッションの開き方」節、設定例、`AGENTS.md`、
      各パッケージ README、`profiles.json.example`）（依存: T6, T8）
- [x] T10: `npm run lint` / `build` / `test` を通す（依存: T1-T9）
- [x] T11: 実機確認（PUB400）— 5250 表示 / プリンター / ジョブ一覧（依存: T10）
