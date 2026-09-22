# タスク: DBCS の挿入の余地

## テスト方針
- ScreenGrid を通す単体（`dbcs-insert-room.test.ts`）。mutation。実機は変更前に ACS のコアで測った。

## タスク
- [x] T1: `absorbDbcs` の全角空白と `atLastColumn`・`dbcsType`・貼り付けの通知。
      対象: `packages/web-ui/src/components/ScreenGrid.vue` `absorbDbcs` `dbcsType` / 根拠: research A1, A2
      依存: なし
      AC: AC1, AC2, AC3
- [x] T2: テストと mutation、実機の測定の記録。
      対象: `packages/web-ui/test/dbcs-insert-room.test.ts` `scripts/acs-probe/dbcs-insert-room.txt`
      依存: T1
      AC: AC1, AC2, AC3, AC4
