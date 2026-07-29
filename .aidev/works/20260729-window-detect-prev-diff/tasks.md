# タスク: 前画面との差分でウィンドウ判定の誤検出（③）を消す

- [x] T1: 実機 34 対から代表を選び fixture 化する
      （本物の窓 9 対すべて＋通常画面から数対。612KB 全部は入れない）
- [x] T2: `fkeyLegend.ts` に `sameScreen()` と `introducedOutside()` を足す（依存: なし）
  - 外周は `{row1-1, row2+1, col1-1, col2+1}`
  - 「現在が空白かつ非反転」のセルは飛ばす（枠が DBCS の片割れを潰した跡）
  - 画面サイズが違えば比較しない
- [x] T3: `detectWindowRect` に `prev` 引数を足し、候補確定後に裏取りする（依存: T2）
  - **`prev` 不在時は 1 行も挙動を変えない**
- [x] T4: `packages/web-ui/test/window-prev-diff.test.ts` を書く（依存: T1, T3）
  - 実機 fixture の窓 9/9 が検出される
  - ③ への遷移が `null`
  - 無変化な再描画で `sameScreen` が true
  - `prev` 無しで現行と同じ結果
- [x] T5: `ScreenGrid.vue` の判定を watch へ移す（依存: T3）
  - `decoWindow` は設定ガード＋ ref を返すだけにする
  - `showShiftMarks` / `sbcsView` も watch 対象に含める
- [x] T6: 既存 6 本（`window-view` / `stacked-window` / `reverse-frame-window` /
      `pane-cursor-window` / `window-write-extent` / `real-help-window`）の通過を確認（依存: T3, T5）
- [x] T7: 空振り検証 — 裏取りを外すと ③ のテストが落ちることを確認（依存: T4）
- [x] T8: `npm run build -w @as400web/web-ui`（vue-tsc 込み）と全テストを通す（依存: 全部）
