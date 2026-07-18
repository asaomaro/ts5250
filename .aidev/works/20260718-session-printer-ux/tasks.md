# タスク: 接続・セッション情報表示とプリンター UX 改善

## 1. store
- [x] T1: `stores/sessions.ts` に `SessionMeta`・`SessionState.meta`・`unread` を追加、`addReport` で unread++、`markSpoolRead(id)` を追加
- [x] T2: store テスト（unread 増加/クリア・meta 保持）（依存: T1）

## 2. session-controller
- [x] T3: `session-controller.ts` の `openSession`/`openPrinterSession` に `meta?` 引数を追加し state に保存（依存: T1）

## 3. 汎用ポップオーバー
- [x] T4: `components/InfoPopover.vue` を新規作成（rows 表示＋バックドロップ/ⓘ で閉じる・本体は click.stop）

## 4. ConnectView（項目1・2）
- [x] T5: カード/一覧にデバイス名を表示（項目1）（依存: なし）
- [x] T6: カードに ⓘ ＋ InfoPopover で全情報表示（項目2）（依存: T4）
- [x] T7: 接続時に接続メタを `openSession`/`openPrinterSession` へ供給（依存: T3）

## 5. SessionInfo（項目3・4）
- [x] T8: `SessionInfo.vue` にバックドロップ close を追加（項目3）（依存: T1）
- [x] T9: `SessionInfo.vue` に `state.meta` の接続情報を統合表示（重複統合）（項目4）（依存: T1）

## 6. PaneTabs（項目3・7）
- [x] T10: タブ情報のバックドロップ close を配線（項目3）（依存: T8）
- [x] T11: プリンタータブに未読バッジ（`unread>0`）を表示（項目7）（依存: T1）

## 7. PrinterPane（項目5・6・7）
- [x] T12: 待ち受けヒントに CPA3394 回避（`STRPRTWTR … FORMTYPE(*ALL)`）＋コピー（項目5）（依存: T1）
- [x] T13: サイドバー開閉トグル＋上部フィルタ入力（title/本文の部分一致）（項目6）
- [x] T14: 表示時/受信時に `markSpoolRead` で未読クリア（項目7）（依存: T1）

## 8. ドキュメント
- [x] T15: README のプリンターセッションに FORMTYPE(*ALL) 運用を追記（依存: T12）

## 9. 検証
- [x] T16: web-ui テスト追加/更新（store・ConnectView・SessionInfo・PaneTabs・PrinterPane）
- [x] T17: `npm run build -w @as400web/web-ui`（vue-tsc+vite）・`npm test`・`npm run lint` が全て green
