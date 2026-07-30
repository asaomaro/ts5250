# タスク: 入力支援 UI（F4 の導線）

- [x] T1: `fkeyLegend.ts` に `detectPromptKey(snap, charOf?)`（`key === "F4"` の凡例を 1 件返す）
- [x] T2: `viewSettings.ts` に `promptHint: boolean`（型・`VIEW_ITEMS`・`FALLBACK` 既定 false）
- [x] T3: `opMessages.ts` に `MSG_PROMPT_HINT`（ラベルが取れないときの `aria-label`）
- [x] T4: `ScreenGrid.vue` — `promptHint` prop・`promptTarget`・ボタンの描画と `aid("F4")` 送出
      （キーを購読しない / `mousedown.stop.prevent` / `tabindex="-1"`）（依存: T1,T2,T3）
- [x] T5: `EmulatorPane.vue` — 設定を `ScreenGrid` へ渡す（依存: T4）
- [x] T6: テスト `prompt-hint.test.ts`（検出・表示条件・送出・不変条件・既定）（依存: T5）
- [x] T7: 文書 — `scripts/README.md` に 3 本を登録、`.aidev/backlog/input-assist.md` に
      5 件の結論（datepicker は実測つきで「作らない」）、`decisions.md`（依存: T6）
