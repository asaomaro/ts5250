# タスク: EDTMSK 分割欄の日付・時刻ピッカー

- [x] T1: 判定の純関数を作る。`DateTimeKind` / `DateTimeShape` / `DateTimeTarget` 型、
      `detectDateTimeFields`（入口条件＋判定表）、`parseValue`、`formatValue`。
      区切りは `/` `-` `.`（日付）/ `:`（時刻）で、**`.` は未実測**とコメントに明記する。
      2 桁年の窓（`00–69`→`20xx` / `70–99`→`19xx`）の根拠もコメントに残す。
      対象: `packages/web-ui/src/composables/dateTimeField.ts`（新規作成）/
      手本 `packages/web-ui/src/composables/fkeyLegend.ts:617` `detectOptionHints` / 根拠: research A1
- [x] T2: 判定の単体テストを書く（依存: T1）。正例 5（`4,2,2 /`・`2,2,2 /`・`2,2,2 :`・`2,2 /`・`2,2 :`）、
      `both` 2（`2,2,2` 空白・`2,2` 空白）、負例 8（`3,2,4 -`＝SSN・単独欄・普通の数値欄・
      隙間が 2 桁以上・保護区間の混在・非数値区間の混在・区切り不揃い・`4,2,2 :`・`2,2,4`）。
      `parseValue`/`formatValue` の往復と 2 桁年の窓も固定する。
      対象: `packages/web-ui/test/datetime-field.test.ts`（新規作成）/
      snapshot の組み立ては `packages/web-ui/test/continued-field-edit.test.ts` に倣う / 根拠: research A9
- [x] T3: 設定 `dtPicker`（`"none" | "panel" | "outline" | "crt"`・既定 `"none"`）を足す。
      `interface ViewSettings` / `VIEW_ITEMS`（`optHints` の直後・`wide` ＋ `expandable`）/ `FALLBACK` の 3 か所。
      対象: `packages/web-ui/src/stores/viewSettings.ts:73` `:117` `:201` / 根拠: research A8
- [x] T4: 文言定数 `MSG_DATE_PICKER` / `MSG_TIME_PICKER`（と書式見出しの語）を足す。
      です・ます調・句点なし。テストは定数を参照させる。
      対象: `packages/web-ui/src/composables/opMessages.ts:24` 付近（`MSG_OPT_HINTS` の隣）
- [x] T5: ピッカー本体を作る（依存: T1・T4）。日付＝年月送り＋日グリッド＋「今日」、
      時刻＝時 / 分 /（秒）の列、`both`＝日付 / 時刻のタブ。見出しに解釈中の書式を出す。
      `mousedown.stop.prevent`、`Esc` で閉じる（**このコンポーネント自身の `keydown` のみ**）。
      対象: `packages/web-ui/src/components/DateTimePicker.vue`（新規作成）/ 根拠: spec「ピッカーの中身」
- [x] T6: ポップオーバーの意匠を `.crt-pop` へ括り出し、`.opt-hints` と共有する。
      **`.opt-hints` のクラス名は残す**（既存セレクタ・テストを壊さない）。
      対象: `packages/web-ui/src/components/ScreenGrid.vue:3830`〜`3905`（`.opt-hints` の CSS）/ 根拠: decisions D7
- [x] T7: `ScreenGrid` へ組み込む（依存: T1・T3・T5・T6）。`dtPicker` prop、判定 computed
      （`none` なら評価しない）、`▾` ボタン（最終区間の右隣 1 桁・絶対配置）、開閉 state と
      外側クリック／画面変化での自動クローズ、`pasteFrom` での書き込み、
      `defineExpose` に `dtPickerOpen` / `openDateTimePicker`。
      対象: `packages/web-ui/src/components/ScreenGrid.vue:110`（props）`:948`（判定 computed の手本）
      `:995`（開閉 state の手本）`:1098` `chooseOption`（書き込みの手本）`:2697` `pasteFrom`
      `:3419`〜`3456`（markup の手本）`:3352`（expose）/ 根拠: research A3〜A7
- [x] T8: `EmulatorPane` を配線する（依存: T7）。`:dt-picker="view.dtPicker"` の受け渡し、
      `Alt+↓` を `openOptHints() || openDateTimePicker()` へ拡張、
      ピッカーが開いている間のキー優先（`closest(".dtp")` を既存の `.opt-hints` 判定に足す）。
      **新しい `keydown` リスナーは足さない。**
      対象: `packages/web-ui/src/components/EmulatorPane.vue:856`（キー優先）`:865`（`Alt+↓`）
      `:982`（props 受け渡し）/ 根拠: research A7
- [x] T9: UI の単体テストを書く（依存: T8）。既定でボタン 0 件（AC5）、`VIEW_ITEMS` に `dtPicker` がある（AC5）、
      `mousedown.stop.prevent` が付いている・**グリッドに新しい `keydown` を足していない**（AC6）、
      選ぶと欄の値が変わる。文言はリテラルでなく定数を参照する。
      対象: `packages/web-ui/test/datetime-picker-ui.test.ts`（新規作成）/
      観点の手本 `packages/web-ui/test/opt-hints-ui.test.ts` / 根拠: research A9
- [x] T10: 実機 E2E に項目を足す（依存: T8）。`D8U`（行 23・`4,2,2`・`/`）で日付を選んで
      ホストへ届くこと、`TMW`（行 11・`2,2,2`）で**空欄のとき `both`・値ありのとき `time`** に
      なり、どちらでも時刻を書き込めること。装置名はプールを回す。
      対象: `scripts/verify-browser-edtmsk-edit.mjs:34`（`ROW`/`COL`/`SEG` の定義）/ 根拠: research A10・A11
- [x] T11: `research-edtmsk.mjs` の接続先を env 優先へ直す（独立）。`connections.json` に
      無ければ `AS400_HOST` / `AS400_USER` / `AS400_CCSID` から組み立てる。
      対象: `scripts/research-edtmsk.mjs:124` 付近（`conns.systems.find`）/
      手本 `scripts/build-dttest.mjs:158` / 根拠: decisions D8
- [x] T12: 一式を通す（依存: T9・T10・T11）。`npm run build`（`tsc -b`）→
      **`npm run build -w @ts5250/web-ui`（`vue-tsc`）** → **`cd packages/web-ui && npx vitest run`** →
      `npm test`（全 workspace）→ `npm run lint`。
      対象: リポジトリ全体 / 根拠: AGENTS.md「ビルド・テスト」（R5・R6）
