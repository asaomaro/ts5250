# タスク: 待ち受けの開始/停止

- [x] T1: `WatchState` を `ServiceState` に寄せる（`watching` → `listening`・`stopped` 追加）
- [x] T2: `WatchRegistry.stop()` が削除をやめ、`resume()` を足す（依存: T1）
- [x] T3: 監視の上限を待ち受け中で数える（依存: T2）
- [x] T4: web-ui の状態表示を追随（停止中はグレー＝動いていないと分かる形）（依存: T1）
- [x] T5: `PrinterEntry.session` を省略可能にし、`state` / `openOpts` / `onState` を持たせる
- [x] T6: `startPrinter` / `stopPrinter` を足し、`autoStart` を尊重する（依存: T5）
- [x] T7: プリンターの上限を `holdsConnection` で数える（依存: T6）
- [x] T8: WS メッセージ（`printer-start` / `printer-stop` / `watch-resume` / `printer-state`）とハンドラ（依存: T6）
- [x] T9: テスト（監視 3 件追加・プリンター 8 件追加・既存を実態へ）（依存: T1〜T8）
- [x] T10: 実機で 開始 → 受信 → 停止 → 再開（依存: T9）
- [x] T11: `npm run build` / `npm run lint` / `npm test`
