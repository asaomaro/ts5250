# タスク: 継続欄の Erase EOF・Field Exit・Dup

## テスト方針
- ScreenGrid とペインを通す単体（`continued-field-exit.test.ts`）。mutation。実機は変更前に ACS のコアで測った。

## タスク
- [x] T1: `fillFollowingSegments` と 4 つのキーへの配線、`field-full` の `leaving`、`onFieldFull` の行き先。
      対象: `packages/web-ui/src/components/ScreenGrid.vue` `packages/web-ui/src/components/EmulatorPane.vue` / 根拠: research A1, A2
      依存: なし
      AC: AC1, AC2, AC3, AC4
- [x] T2: テストと mutation、実機の測定の記録（手順・DUP 可の継続欄の画面）。
      対象: `packages/web-ui/test/continued-field-exit.test.ts` `scripts/acs-probe/continued-field-erase-exit.txt` `scripts/build-ulktest.mjs`
      依存: T1
      AC: AC1, AC2, AC3, AC4
