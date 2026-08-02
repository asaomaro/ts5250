# タスク: 待ち行列サービスの非対称性を直す

- [x] T1: `WatchRegistry.register()` を足し、`start()` を組み直す
- [x] T2: `resume()` の失敗を `error` ＋ 理由として残す（依存: T1）
- [x] T3: `service-reconcile.saveWatch` を「登録 → 開始」に（依存: T1, T2）
- [x] T4: 既存テストを意図した変化に合わせて書き換える（依存: T1〜T3）
- [x] T5: 失敗時の振る舞いのテストを足す（依存: T2）
- [x] T6: 実機の通し（`verify-browser-watch.mjs`）
- [x] T7: `npm run build` / server の全テスト
