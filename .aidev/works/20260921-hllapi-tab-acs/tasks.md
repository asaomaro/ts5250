# タスク: HLLAPI の Tab・Backtab

## テスト方針
- 行き先の純関数の単体（実機の ACS の値）と HLLAPI の送信のカーソル。mutation。

## タスク
- [x] T1: 行き先の純関数と HLLAPI の配線。テスト。
      対象: `packages/tn5250/src/screen/search.ts` `packages/server/src/hllapi.ts`
      依存: なし
      AC: AC1, AC2, AC3
