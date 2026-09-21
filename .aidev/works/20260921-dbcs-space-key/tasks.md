# タスク: DBCS の Space

## テスト方針
- ScreenGrid を通す単体（`dbcs-space-key.test.ts`）。mutation。実機は変更前に ACS のコアで測った。

## タスク
- [x] T1: `spaceToFullWidth` と、打鍵の経路への配線。
      対象: `packages/web-ui/src/components/ScreenGrid.vue` `onDbcsKeydown` / 根拠: research A1
      依存: なし
      AC: AC1, AC2, AC3
- [x] T2: テストと mutation、実機の測定の記録。
      対象: `packages/web-ui/test/dbcs-space-key.test.ts` `scripts/acs-probe/dbcs-space-key.txt`
      依存: T1
      AC: AC1, AC2, AC3, AC4
