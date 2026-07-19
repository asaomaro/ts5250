# タスク: 30-web-ui

- [x] T1: `stores/systems.ts` — 一覧・選択中システム・接続本数・CRUD
- [x] T2: `stores/sessions-config.ts` — セッション設定の一覧と CRUD（依存: T1）
- [x] T3: `session-controller.ts` — `open` を `session` / `system` 参照に（依存: T1, T2）
- [x] T4: `stores/workspace.ts` — `tabSystem` / `lastActiveBySystem` を追加。
      **タブ配列は書き換えない**（依存: なし）
- [x] T5: `ConfigCard.vue` — カード ⇄ その場編集。システム / セッション両用。
      パスワードは空送信で既存維持。printer 欄はサーバー設定かつ編集可のときだけ（依存: T1, T2）
- [x] T6: `LauncherPane.vue` — 未選択＝システム一覧 / 選択後＝セッション + 機能 7 枚（依存: T5）
- [x] T7: `PaneTabs.vue` — `tabSystem` フィルタ、`＋` ボタン、`list:*` ラベル修正（依存: T4, T6）
- [x] T8: `App.vue` — ヘッダーをシステム選択＋利用者名のみに（依存: T6, T7）
- [x] T9: `HostListPane.vue` — 接続元 select を削除、選択中システムを使う。ストア経由へ（依存: T1）
- [x] T10: `ConnectView.vue` を削除（必要な検証ロジックは T5 へ移す）（依存: T6, T8）
- [x] T11: テスト（ストア・フィルタ・ラベル・既存 289 件の維持）（依存: T1-T10）
- [x] T12: `npm run lint` / `build` / `test`（依存: T11）
- [ ] T13: ブラウザ実操作確認（依存: T12）
