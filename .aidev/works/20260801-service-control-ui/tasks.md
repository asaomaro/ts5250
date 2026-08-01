# タスク: サービスの操作を画面から行う

- [x] T1: `PublicSession.printer?` を足し、`publicSession` が `includeTrusted` のときだけ返す
- [x] T2: `host-printers.ts` の一覧が `includeTrusted` を渡していないことを確認する（依存: T1）
- [x] T3: `SessionConfigForm` に `autoStart` と `printer.service` を足す
- [x] T4: `SessionState` に `state` / `serviceError` を足す
- [x] T5: `session-controller` に `startPrinter` / `stopPrinter` を足す（依存: T4）
- [x] T6: `printer-opened` で `state` を持ち、`printer-state` で更新する（依存: T4）
- [x] T7: `watchesStore.resume` を足す
- [x] T8: `ConfigCard` に `loadPrinter` を足し、保存で printer を送り返す（依存: T1, T3）
- [x] T9: `ConfigCard` に `自動で待ち受け開始` ✅ を足す（依存: T3）
- [x] T10: `ConfigCard` に `サービスとして常駐する` ✅ を足す（依存: T3, T8）
- [x] T11: `ConfigCard` の詳細（ⓘ）に 2 つの設定を出す（依存: T9, T10）
- [x] T12: `PrinterPane` に状態表示と開始/停止ボタンを足す（依存: T5, T6）
- [x] T13: `PrinterPane` の「待ち受け中…」案内を待ち受け時だけにする（依存: T12）
- [x] T14: `WatchPane` の操作列を停止/開始で出し分ける（依存: T7）
- [x] T15: サーバーのテスト（`publicSession` の出し分け・API の出し分け）（依存: T1）
- [x] T16: `npm run build` / `vue-tsc` / `npm run lint` / `npm test`（依存: 全部）
- [x] T17: `npm run build` が web-ui の `vue-tsc` も通すようにする（型検査から漏れていた）
