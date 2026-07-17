# レビュー記録
## ラウンド 1（autonomous 自己レビュー・2026-07-17）
指摘なし。
- 認証: scrypt/sha256・timingSafeEqual、httpOnly Cookie、256bit sid、Bearer トークン。新規依存なし。
- per-user 分離: owner を SessionManager で強制（get/getPrinter/list/close/assert*）。HTTP/MCP/WS 全経路。
  プリンター ID randomUUID 化で推測不能。認証 OFF は user=undefined で全通過（後方互換）。
- セキュリティ: パスワード/トークン非平文、users*.json は gitignore、直接接続は出力設定・owner 詐称不可。
- 全 486 テスト green（401/403/admin/bearer/OFF 後方互換の統合テスト含む）・lint/build クリーン。
