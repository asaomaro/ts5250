# 調査: 認証・分離の実現性（環境確認）

## 判明した事実
- **F1 crypto は Node 標準で完結**: `scrypt`（パスワード/トークンハッシュ）・`randomBytes`（セッション/トークン/salt）・
  `timingSafeEqual`（タイミング安全比較）・`randomUUID`（推測不能 ID）・`createHmac`（Cookie 署名）がすべて
  `node:crypto` にある。**認証に新規依存は不要**。
- **F2 hono ミドルウェア/Cookie**: `hono/helper/cookie`（setCookie/getCookie・署名版あり）、`bearer-auth`/`csrf` 等の
  ミドルウェアが利用可能。`app.use(...)` で /api・/ws・/mcp を保護できる。
- **F3 WS 認証**: `/ws` は hono ルート（`app.get("/ws", upgradeWebSocket((c)=>...))`）なので、upgrade 前に
  ミドルウェア/ハンドラで Cookie を検査できる。認証 NG なら upgrade しない。
- **F4 MCP 認証**: `/mcp` は `app.all("/mcp")` でリクエスト毎に MCP サーバーを構築する。ミドルウェアで Bearer を
  検証し、認証ユーザーを**その回の MCP ツール deps に注入**すれば per-user 強制が効く。
- **F5 分離の穴（現状）**: プリンター ID は連番 `prt-${seq}`（推測可能）。表示は server が randomUUID を渡している。
  → プリンターも `id?` を PrinterConnectOptions に足し、server 側で randomUUID を渡す（core は純粋なまま）。

## 設計方針
- `auth.ts`（server 新規）に UserStore（users.json・scrypt）＋セッションストア（in-memory・httpOnly Cookie）＋
  authMiddleware（Cookie or Bearer→user）＋login/logout/me を集約。認証は設定で on/off。
- SessionManager のエントリに `owner` を付け、HTTP(PDF)/MCP の取得で所有者一致を強制（admin は全許可）。
  WS は 1 接続 = 1 セッションで既に自然分離だが、開いたセッションに owner を刻む。
- 認証 OFF 時は user=undefined でチェックをスキップ（後方互換）。
