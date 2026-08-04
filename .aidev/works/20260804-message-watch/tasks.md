# タスク: メッセージ待ち行列の待ち受け

- [x] T1: `watch-source.ts` に `WatchSource` / `WatchLink` / `WatchItem` を定義し、dtaq 版を作る
- [x] T2: `WatchRegistry` を `WatchSource` 経由にする（既存テストが無変更で通ること）（依存: T1）
- [x] T3: `CommandConnection.call()` にこの往復だけの read タイムアウトを足す
- [x] T4: `message-receive.ts`（`QMHRCVM` 組み立て＋`RCVM0200` 読み取り）＋単体テスト
- [x] T5: `MsgqSource`（カーソル・`onlyInquiry`・`includeExisting`）＋単体テスト（依存: T2, T3, T4）
- [x] T6: `msgWatchSchema` と `sessionType: "msgwatch"`（依存: T5）
- [x] T7: 起動・反映・一覧の経路（`config-store` / `boot-autostart` / `service-reconcile` / `host-printers`）（依存: T6）
- [x] T8: 画面（`ConfigCard` の種別追加、`WatchPane` の表示、消費警告を msgq に出さない）（依存: T7）
- [x] T9: 実機検証スクリプト `scripts/verify-message-watch.mjs`（依存: T8）
- [x] T10: 全テスト・lint・型検査を通す（依存: T9）
