# タスク: 何も無い状態からサービス開始までを通しで確かめる

- [x] T1: `verify-fresh-service-setup.mjs`（空のディレクトリで起動 → 画面操作）
- [x] T2: 立ち上げ失敗時に実体を残す（登録してから開始）（依存: T1 が見つけた）
- [x] T3: 単体テストを直し、失敗時の振る舞いを足す（依存: T2）
- [x] T4: `scripts/README.md`
- [x] T5: `npm run build` / `lint` / テスト
