# 計画: サーバー設定を admin 限定にする

## 実装方針
認可関数 → ストア → 各呼び出し元 の順（下から上へ）。ストアが user 必須になった時点で
呼び出し元の型エラーが出るため、tsc が「渡し忘れ」を機械的に検出してくれる（漏れ防止）。

## 作業順序と依存関係
1. `auth.ts` に `assertProfileAccess` を追加（依存: なし）
2. `profiles.ts`: `resolveConnectOptions` / `resolvePrinterOutput` に user、`listForUser` 新設（依存: 1）
3. `app.ts`: `GET /api/profiles` を `listForUser` へ（依存: 2）
4. `ws-handler.ts`: 3 箇所に `this.user` を渡す（依存: 2）
5. `mcp-tools.ts`: 4 箇所に `user` を渡す（依存: 2）
6. テスト追加（一般=空/403、admin・認証オフ=従来どおり）（依存: 3,4,5）
7. ドキュメント更新（README の MCP 表 / AGENTS の権限表）（依存: 6）
8. 全体検証（tsc / ビルド / 全テスト / lint）（依存: 6,7）

## リスク / 留意点
- **`listPublic` を書き換えない**: `profiles.ts:284` が内部の名前解決に使っており、変えると profile 解決が壊れる。
- **認証オフ・admin の回帰**: `assertProfileAccess` は `!user` で即 return。既存テストで担保する。
- `resolveConnectOptions` の引数順が `(name, warn?)` → `(name, user?, warn?)` に変わる。warn を渡す既存
  呼び出し（ws-handler 2 箇所）の**引数ずれ**に注意。

## テスト方針
- server: 一般ユーザーで一覧が空・profile 接続/signon が FORBIDDEN、admin と認証オフは従来どおり。
- 既存テストが落ちないこと（＝認証オフ経路の回帰）。
