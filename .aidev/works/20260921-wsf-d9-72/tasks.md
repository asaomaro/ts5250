# タスク: WSF D9/72 への応答

## テスト方針
- セッション経由の応答のバイト列（ACS のコアの実測値）。実機で DSM に出させてホストが読んだ値。mutation。

## タスク
- [x] T1: D9/72 を拾って ACS と同じ応答を返す。DSM の試験プログラムに `WSF72` / `WSF72N` を足して実機で測る。テスト。
      対象: `packages/tn5250/src/protocol/wtd-applier.ts` `packages/tn5250/src/protocol/query-reply.ts` `packages/tn5250/src/session/session.ts` `scripts/host-src/dscmd.c`
      依存: なし
      AC: AC1, AC2, AC3
