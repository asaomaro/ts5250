# タスク: ROLL

## テスト方針
- 単体（送り・空いた行・不正な指定）と実機（ACS のコアと当 PJ を同じ試験プログラムで）。mutation。

## タスク
- [x] T1: 実測（試験プログラム・ACS のコア・当 PJ）。
      対象: `scripts/host-src/dscmd.c`（ROLLTEST）`scripts/acs-probe/roll-vacated-{up,down}.txt` `scripts/verify-roll.mjs`
      依存: なし
      AC: AC1
- [x] T2: `roll` の書き換えとテスト。
      対象: `packages/tn5250/src/screen/buffer.ts` `test/screen-roll.test.ts`
      依存: T1
      AC: AC1, AC2, AC3
