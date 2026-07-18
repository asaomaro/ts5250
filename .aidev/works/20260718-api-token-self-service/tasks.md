# タスク: API トークンの自己発行と再発行による失効

- [x] T1: `issueToken` を置き換え方式に＋`hasToken`
- [x] T2: `POST /api/me/token`（自己発行）と `/api/me` の `hasToken`
- [x] T3: server テスト（失効・自己発行・未認証・認証オフ・既存互換・平文非保存）
- [x] T4: `AccountPopover.vue` と App.vue の配線
- [x] T5: web-ui テスト（警告・発行前後・失敗表示）
- [x] T6: README（トークン設定手順・stdio に認証が無い旨）
- [x] T7: 全体検証
