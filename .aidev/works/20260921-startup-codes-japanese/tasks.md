# タスク: 起動応答で断られた理由を日本語で出す

## テスト方針
- 文言の単体・出し分け・開く前の reject。一覧の固定。mutation。

## タスク
- [x] T1: 英語の表の意味を直し、日本語の表と文言の関数を足して、通知と開く前の失敗に使う。テスト。
      対象: `packages/tn5250/src/telnet/startup-record.ts` `packages/tn5250/src/session/printer-session.ts` `packages/web-ui/src/composables/opMessages.ts` `packages/web-ui/src/session-controller.ts`
      依存: なし
      AC: AC1, AC2, AC3
