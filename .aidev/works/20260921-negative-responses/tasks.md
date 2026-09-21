# タスク: 否定応答

## テスト方針
- 条件ごとのセンス・コードと送るバイト列。実機で ACS と比べる。mutation。

## タスク
- [x] T1: 否定応答の組み立てと、4 条件での送信、未知のコマンドの読み飛ばし。DSM の試験プログラムに `WSF72X` / `ROLLBAD` を足して実機で比べる。テスト。
      対象: `packages/tn5250/src/protocol/gds.ts` `packages/tn5250/src/protocol/wtd-applier.ts` `packages/tn5250/src/session/session.ts` `scripts/host-src/dscmd.c`
      依存: なし
      AC: AC1, AC2, AC3
