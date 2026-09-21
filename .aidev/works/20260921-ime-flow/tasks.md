# タスク: IME の余りを次の欄へ流す

## テスト方針
- ペイン結合の単体（複数の欄）。mutation。GUI 層の IME は headless で測れないので原典の読みに合わせ、未測定と明記する。

## タスク
- [x] T1: `commitInto`・`flowToNextField` への切り出しと配線、ペイン結合のテストと mutation。
      対象: `packages/web-ui/src/components/ScreenGrid.vue` `packages/web-ui/test/ime-flow-next-field.test.ts` / 根拠: research A1
      依存: なし
      AC: AC1, AC2, AC3
