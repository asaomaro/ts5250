# タスク: Field Exit・Field± の前の検査

## テスト方針
- 純ロジックとペインでの振る舞い（実機の ACS で測った場合）。mutation。

## タスク
- [x] T1: 検査の純関数と、Field Exit・Field± の前での呼び出し。ME の Field Exit の文言。テスト。
      対象: `packages/web-ui/src/composables/mandatoryCheck.ts` `packages/web-ui/src/components/ScreenGrid.vue` `packages/web-ui/src/composables/opMessages.ts`
      依存: なし
      AC: AC1, AC2, AC3, AC4
