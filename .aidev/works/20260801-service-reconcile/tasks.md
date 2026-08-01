# タスク: 定義の変更をサービスに反映する

- [x] T1: `service-reconcile.ts`（saved / removed の分岐）
- [x] T2: `SessionManager.updatePrinterOptions` ＋ `PrinterEntry.stale`
- [x] T3: `WatchRegistry.update` / `remove` ＋ `WatchView.stale`
- [x] T4: `WatchEvent` に `list` を足し、ws-handler が一覧を配り直す（依存: T3）
- [x] T5: `config-routes` に `onSessionChanged` を足す
- [x] T6: `app.ts` で配線（`WatchRegistry` を CRUD より先に作る）（依存: T1, T5）
- [x] T7: `stale` を一覧の行と画面に出す（依存: T2, T3）
- [x] T8: 単体テスト（依存: T1）
- [x] T9: 実機 E2E に「定義の変更を反映する」節を足す（依存: 全部）
- [x] T10: `npm run build` / `lint` / `npm test`
