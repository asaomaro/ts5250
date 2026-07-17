# 仕様: 管理者画面（PR 2）
## 設計方針
admin 専用 API（/api/admin/*、role=admin ガード）を追加。UserStore に mutation＋users.json 保存を足す。
監査ログは in-memory リングバッファ（setAuditSink で既存 audit を分岐）。UI は "admin:*" 特殊タブ ID を
workspace に足し、PaneTabs/WorkspaceNode で特別扱いして AdminPane を描画。
## インターフェース
- server auth.ts: `requireAdmin` ミドルウェア（c.get("user").role!=="admin"→403）。
- server admin.ts: registerAdminRoutes(app, {users, sessions, auditBuffer}):
  - GET /api/admin/users →[{username,role,tokenCount}]／POST（{username,password,role}）／
    PUT /:username（{role?,password?}）／DELETE /:username／POST /:username/token →{token}(1回のみ)
  - GET /api/admin/sessions →全表示/プリンター [{id,kind,owner,host,origin,connectedAt}]／DELETE /:id
  - GET /api/admin/logs →最近の AuditEvent[]
- UserStore: add/update/remove/addToken＋saveFile(path)。SessionManager: listAll()（表示+プリンター統合）。
- audit.ts: AuditBuffer（push＋recent(n)）、installAuditBuffer() で sink を分岐（stderr も継続）。
- web-ui: authStore.isAdmin で top に管理セクション。workspaceStore.addSession("admin:users"|"admin:sessions"|"admin:logs")。
  PaneTabs.label/WorkspaceNode で "admin:" を分岐。AdminPane.vue が /api/admin/* を fetch。
## セキュリティ
admin ガード必須。トークンは発行時のみ平文、以後 sha256。users.json 書込は tmp→rename で原子的。
認証 OFF は管理セクション非表示・admin API は 404/無効。
