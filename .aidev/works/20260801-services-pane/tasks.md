# タスク: サービス一覧の画面

- [x] T1: `ServiceDef` を足す
- [x] T2: `ConfigStore.listServiceDefs` と `canSeeService`（サーバーは常に true）（依存: T1）
- [x] T3: `ConfigResolver.listServiceDefs`（依存: T2）
- [x] T4: `host-printers.ts` の出所を差し替え、理由を `canEditServer` で絞る（依存: T3）
- [x] T5: `app.ts` から `canEditServer` を渡す（依存: T4）
- [x] T6: `printer-service-start`（メッセージ＋ハンドラ＋dispatch）
- [x] T7: `stores/services.ts`（依存: T4, T6）
- [x] T8: `ServicesPane.vue`（依存: T7）
- [x] T9: `svc:` を `paneLabels` / `WorkspaceNode` / `LauncherPane` に登録（依存: T8）
- [x] T10: `host-printers.test.ts` を新しい出所に直す（依存: T4）
- [x] T11: 露出のテスト（`listServiceDefs` / ルートの出し分け）（依存: T4）
- [x] T12: 実機 E2E スクリプト（依存: 全部）
- [x] T13: `npm run build` / `lint` / `npm test`
