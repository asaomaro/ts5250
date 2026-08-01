# タスク: 認証を有効にしたときの確認

- [x] T1: `UserStore` / `SessionStore` と認証の型を `@as400web/server` から公開
- [x] T2: `verify-service-auth.mjs`（admin / 一般ユーザーの 2 文脈）（依存: T1）
- [x] T3: ランチャーの「アプリ」段をシステム選択の外へ出す（依存: T2 が見つけた）
- [x] T4: `onPrinterStop` の `void withAudit` を `await` に直す（依存: T2 が見つけた）
- [x] T5: 拒否が返ることの単体テスト（依存: T4）
- [x] T6: `scripts/README.md` に項目を足す
- [x] T7: `npm run build` / `lint` / `npm test`
