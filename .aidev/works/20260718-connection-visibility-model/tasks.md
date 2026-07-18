# タスク: 接続設定 UI から所有概念を廃止する

- [x] T1: `settings-move.ts` と `app-settings-move.test.ts` を削除し、`app.ts` の import/登録を外す
- [x] T2: ConnectView から所有 UI を削除（所有セレクタ・移動ボタン・共有/個人チップ）（依存: T1）
- [x] T3: 未使用になった関数/computed を削除（`canChooseOwnership` / `setOwnership` / `onOwnershipChange` / `moveOwnership`）（依存: T2）
- [x] T4: 表記を「サーバー設定」へ（チップ・InfoPopover・注記）＋ `formTitle` を一本化（依存: T3）
- [x] T5: `connect-view-ownership.test.ts` を表記追随＋所有 UI 非表示の回帰を追加（依存: T4）
- [x] T6: README / docs/UI-DESIGN.md / AGENTS.md の表記更新と `passwordEnv` 別軸の明記（依存: T4）
- [x] T7: 全体検証（tsc -b / web-ui ビルド / 全テスト / lint）（依存: T5,T6）
