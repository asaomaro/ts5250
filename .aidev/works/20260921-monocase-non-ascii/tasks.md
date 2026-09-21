# タスク: SBCS のセッションの打鍵と MONOCASE

## テスト方針
- 判定の単体・グリッドの打鍵・ペインの CCSID による分岐。mutation。

## タスク
- [x] T1: 判定とバイト長にセッションの種類を足し、グリッド・ペインへ通す。MONOCASE の大文字化。テスト。
      対象: `packages/web-ui/src/composables/fieldValidate.ts` `packages/web-ui/src/components/ScreenGrid.vue` `packages/web-ui/src/components/EmulatorPane.vue` `packages/tn5250/src/browser.ts`
      依存: なし
      AC: AC1, AC2, AC3
