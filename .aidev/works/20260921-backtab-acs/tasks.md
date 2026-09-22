# タスク: Backtab の行き先

## テスト方針
- ペインを組んで Shift+Tab を欄の input に送り、フォーカスとキャレットを見る。実測の例を使う。mutation。

## タスク
- [x] T1: ACS の実測（Backtab 5 例と Home）。
      対象: `scripts/acs-probe/backtab-home.txt`
      依存: なし
      AC: AC1
- [x] T2: `backtab()` と `caretAtFieldStart()`。
      対象: `packages/web-ui/src/components/EmulatorPane.vue` `onLocal` `backtab`、`ScreenGrid.vue` `caretAtFieldStart`
      依存: T1
      AC: AC1, AC2, AC3
- [x] T3: テスト（新規と、ACS と食い違っていた 2 件の書き換え）・mutation。
      対象: `packages/web-ui/test/backtab-acs.test.ts` `continued-field-tab.test.ts` `cursor-progression-nav.test.ts`
      依存: T2
      AC: AC1, AC2, AC3
