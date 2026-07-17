# 計画: 管理者画面（PR 2）
1. UserStore mutation＋saveFile、SessionManager.listAll、audit リングバッファ。
2. requireAdmin＋admin.ts（users/sessions/logs ルート）＋app 配線＋単体。
3. web-ui: AdminPane（users/sessions/logs）、App の管理セクション、PaneTabs/WorkspaceNode の admin タブ分岐。
4. docs。テスト: admin API（CRUD/403/token/sessions/logs）＋既存 green。
