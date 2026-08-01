# タスク: 待ち行列サービスの Webhook 転送

- [x] T1: `webhookSchema` をサーバー設定にだけ足す ＋ 種別との整合（`dtaqwatch` 限定）
- [x] T2: `WebhookSink`（キュー・再試行・未達の記録・配送 id・署名）
- [x] T3: `WatchSink` を `WatchRegistry` に差す（`push` から待たずに渡す）（依存: T2）
- [x] T4: 解決器で秘密を復号（`ResolvedTarget.webhook`）（依存: T1）
- [x] T5: `makeWatchSink` を 3 か所から呼ぶ（起動時・WS・反映）（依存: T3, T4）
- [x] T6: 保存時の URL 検査（依存: T1）
- [x] T7: **秘密の据え置き**（`toWebhookRecord`）（依存: T1）
- [x] T8: `PublicSession.webhook`（**秘密の値は返さない**）（依存: T1）
- [x] T9: `WatchRow` に `hasWebhook` / `undelivered`（依存: T3）
- [x] T10: 設定フォームの信頼設定欄（`dtaqwatch`）（依存: T8）
- [x] T11: サービス一覧に「未達」を出す（依存: T9）
- [x] T12: 単体テスト（sink 21 件・信頼境界と往復 13 件）
- [x] T13: 実機 E2E（`verify-dtaq-webhook.mjs`）
- [x] T14: `npm run build` / `lint` / `npm test`
