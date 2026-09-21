# タスク: 起動応答を CCSID 37 で読む

## テスト方針
- 解析の単体とセッション（ccsid 930）の起動応答。mutation。

## タスク
- [x] T1: `parseStartupResponse` を CCSID 37 固定にし、表示・プリンターの呼び出しとテストを直す。テストを足す。
      対象: `packages/tn5250/src/telnet/startup-record.ts` `packages/tn5250/src/session/session.ts` `packages/tn5250/src/session/printer-session.ts`
      依存: なし
      AC: AC1, AC2
