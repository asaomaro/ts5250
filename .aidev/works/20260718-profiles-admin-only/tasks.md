# タスク: サーバー設定を admin 限定にする

- [x] T1: `auth.ts` に `assertProfileAccess` を追加
- [x] T2: `profiles.ts` に user 引数と `listForUser` を追加（依存: T1）
- [x] T3: `app.ts` の `GET /api/profiles` を `listForUser` へ（依存: T2）
- [x] T4: `ws-handler.ts` の 3 箇所に user を渡す（依存: T2）
- [x] T5: `mcp-tools.ts` の 4 箇所に user を渡す（依存: T2）
- [x] T6: テスト追加（一般=空/403、admin・認証オフ=回帰）（依存: T3,T4,T5）
- [x] T7: README / AGENTS の可視範囲を更新（依存: T6）
- [x] T8: 全体検証（依存: T6,T7）
