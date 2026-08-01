# タスク: 設定モデルと軸の分離

- [x] T1: `service-state.ts` を新設（`ServiceState` 4 状態 / `holdsConnection` / `autoStartOf`）
- [x] T2: `config-types.ts` に `printer.service` と `session.autoStart` を足す（依存: T1）
- [x] T3: `config-resolver.ts` で `service`（5 層目）と `autoStart` を解決する（依存: T2）
- [x] T4: `session-manager.ts` の `resident` 導出を `opts.service` に置き換える（依存: T3）
- [x] T5: `ws-handler.ts` で `service` を配線する（依存: T4）
- [x] T6: テスト——`service-state.test.ts` 新規、`printer-residency.test.ts` を新モデルへ（依存: T5）
- [x] T7: `npm run build` / `npm run lint` / `npm test`（依存: T1〜T6）
