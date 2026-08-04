# タスク: 既存セッションへの attach

- [x] T1: 購読リスト（`subscribePcCommand` / `subscribeReservation`）
- [x] T2: ws-handler を購読リストへ付け替え（依存: T1）
- [x] T3: `WsOpen.sessionId` と attach 経路（依存: T2）
- [x] T4: `GET /api/sessions`（自分の開いているセッション）
- [x] T5: web-ui の一覧と「開く」導線（依存: T3,T4）
- [x] T6: 実機で 2 タブを確かめる（依存: T5）
