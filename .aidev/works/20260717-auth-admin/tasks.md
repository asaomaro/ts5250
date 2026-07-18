# タスク: 認証・分離コア（PR 1）
- [x] A1: auth.ts — UserStore(users.json)/scrypt hashPassword・verify/findByToken、SessionStore(in-memory)＋単体
- [x] A2: authMiddleware（cookie|bearer→user、OFF 素通り、401）＋ /api/login /logout /me ＋ app 配線＋単体
- [x] A3: SessionManager に owner＋assertOwner、PrinterSession に id?（server は randomUUID）＋単体
- [x] A4: HTTP PDF・MCP（per-request user 注入）・WS に owner 強制（list は owner フィルタ/admin 全件）＋単体
- [x] A5: CLI --hash-password、users.json.example、.gitignore、README/docs（認証 on/off・トークン運用）
