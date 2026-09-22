# タスク: 装置名の展開と答え直し

## テスト方針
- 生成器の単体（実測の規則）、表示・プリンターの答え直し、サーバーの値渡し、実機（PUB400）。mutation。

## タスク
- [x] T1: 実測（ACS のコア・タップ・PUB400。大文字化・記号・衝突）。
      対象: `scratchpad/an-dev.mjs` `run-dev-probe.sh`
      依存: なし
      AC: AC1, AC2
- [x] T2: 生成器・telnet・表示とプリンターの答え直し・サーバーの値渡しと繋ぎ直しの撤去。
      対象: `telnet/device-name.ts` `telnet/telnet.ts` `session/session.ts` `session/printer-session.ts` `server/src/session-manager.ts`
      依存: T1
      AC: AC1, AC2, AC3
- [x] T3: テスト・mutation・実機の検証スクリプト・README。
      対象: `test/device-name.test.ts` `startup-reject.test.ts` `printer-session.test.ts` `server/test/device-name-env.test.ts` `scripts/verify-device-name.mjs`
      依存: T2
      AC: AC4
