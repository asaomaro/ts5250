# タスク: 出力に失敗したら応答を止める

## テスト方針
- コアは応答の順、サーバーは失敗・再試行・取消・OFF・切断、ws、画面。実機で止めている間のスプールの状態と、サーバーの経路の全体。mutation。

## タスク
- [x] T1: 前提の実測（止めている間スプールが残るか）とコアの `respondAfter`。
      対象: `packages/tn5250/src/session/printer-session.ts`、`scripts/verify-printer-hold.mjs`
      依存: なし
      AC: AC1, AC3
- [x] T2: サーバーの出力の待ち・再試行・取消と ws。
      対象: `packages/server/src/session-manager.ts`（`outputGate` `runOutputs` `retryPrinterOutput` `cancelPrinterOutput` `failedOnly`）、`ws-handler.ts`、`ws-messages.ts`
      依存: T1
      AC: AC1, AC2
- [x] T3: 画面（バー・ボタン・状態）と文言。
      対象: `packages/web-ui/src/components/PrinterPane.vue`、`session-controller.ts`、`stores/sessions.ts`、`composables/opMessages.ts`
      依存: T2
      AC: AC3
- [x] T4: テスト・実機・mutation・文書。
      対象: `packages/tn5250/test/printer-session.test.ts`、`packages/server/test/printer-hold-response.test.ts`、`packages/web-ui/test/printer-pane-held.test.ts`、
      `scripts/verify-printer-hold-server.mjs`、`README.md`、`scripts/README.md`
      依存: T3
      AC: AC1, AC2, AC3, AC4
