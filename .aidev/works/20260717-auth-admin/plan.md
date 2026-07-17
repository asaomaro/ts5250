# 計画: 認証・分離コア（PR 1）
## 方針
server 内で完結（新規依存なし・node:crypto）。認証 OFF で完全後方互換を保ちつつ、ON で per-user 分離。
## 順序
1. auth.ts（UserStore/scrypt/SessionStore）→ 2. middleware＋login/logout/me＋app 配線 →
3. SessionManager owner＋assertOwner＋printer id randomUUID → 4. HTTP/MCP/WS の owner 強制 →
5. CLI hash-password・users.json.example・.gitignore・docs。
## テスト方針
単体中心（scrypt 検証・token・session・middleware 401/403・owner 強制・OFF 後方互換）。既存 green 維持。
## スコープ外
管理者 UI（ユーザー CRUD/セッション管理/ログ取得/タブ）は PR 2（別作業）。
