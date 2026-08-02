# タスク: エミュレータ画面の余白を ACS 相当に詰める

- [x] T1: 実機で余白を測る
- [x] T2: `.group` / `.tabs` / `.grid` / `.statusbar` を詰める
- [x] T3: `GRID_PAD_X` / `GRID_PAD_Y` を `fitFont.ts` に集約（CSS も TS もそこから）
- [x] T4: クリックの桁逆算を定数へ（3 か所）
- [x] T5: テストの座標計算・期待値も定数へ（`screen-grid` / `pane-nav` / `fit-font`）
- [x] T6: 撮って確かめる
- [x] T7: `npm run build` / `lint` / web-ui 全体
