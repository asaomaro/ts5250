# タスク: 挿入モードの余地を ACS と同じに数える

## テスト方針
- 純関数の単体・ScreenGrid の打鍵（素の欄・行またぎ・符号付き・継続欄・IME・DBCS）。ACS の実測（research F3・F5）と同じ例を使う。mutation。

## タスク
- [x] T1: 実測（ACS のコアで素の欄・行またぎ・符号付き・継続欄）とプローブの `PROBE_ENPTUI`。
      対象: `scripts/acs-probe/insert-no-room.txt` `scripts/acs-probe/insert-no-room-continued.txt` `scripts/acs-probe/AcsProbe.java` `scripts/acs-probe.mjs` `scripts/README.md`
      依存: なし
      AC: AC1, AC2, AC3
- [x] T2: 純関数 `insertChar`。
      対象: `packages/web-ui/src/composables/fieldEdit.ts`
      依存: T1
      AC: AC1, AC2
- [x] T3: 打鍵・IME・継続欄・DBCS の配線。
      対象: `packages/web-ui/src/components/ScreenGrid.vue`（`onInputKeydown` `onCompositionEnd` `editAcrossContinued` `onDbcsKeydown`）
      依存: T2
      AC: AC1, AC2, AC3
- [x] T4: テストと mutation。台帳・AGENTS.md の残課題。
      対象: `packages/web-ui/test/`（`field-edit.test.ts` ほか）、`AGENTS.md`、`.aidev/backlog/acs-parity.md`
      依存: T3
      AC: AC4
