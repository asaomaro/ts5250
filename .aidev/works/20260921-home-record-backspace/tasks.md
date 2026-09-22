# タスク: Home・Record Backspace・欄データを載せない AID

## テスト方針
- コアは応答のバイト列とスナップショットのホーム位置。web-ui はペインで Home を押してフォーカスと送った AID を見る。mutation。

## タスク
- [x] T1: 実測（ACS のコアで Home、タップで Help と Record Backspace のワイヤ）。
      対象: `scripts/acs-probe/backtab-home.txt`
      依存: なし
      AC: AC1, AC2, AC3
- [x] T2: コア（`AidKey`・`NO_DATA_AIDS`・`home`）とサーバーの一覧。
      対象: `packages/tn5250/src/session/aid-keys.ts` `protocol/read-response.ts` `screen/buffer.ts` `screen/types.ts`、`packages/server/src/macro-types.ts` `mcp-tools.ts`
      依存: T1
      AC: AC3
- [x] T3: web-ui の Home と送信の合流点。
      対象: `EmulatorPane.vue` `homeKey`、`ScreenGrid.vue`（欄内 Home の撤去）、`session-controller.ts` `sendKey`、`KeybindingsPanel.vue`
      依存: T2
      AC: AC1, AC2
- [x] T4: テストと mutation。
      対象: `packages/tn5250/test/no-data-aid-home.test.ts`、`packages/web-ui/test/home-key-acs.test.ts`
      依存: T3
      AC: AC4
