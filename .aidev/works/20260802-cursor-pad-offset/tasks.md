# タスク: 重ねる要素の余白補正を定数に従わせる

- [x] T1: `ScreenGrid.vue` の `margin: 8px 0 0 10px` 12 か所を `var(--grid-pad-y) 0 0 var(--grid-pad-x)` へ
- [x] T2: `fitFont.ts` の注記を実態に合わせる（依存: T1）
- [x] T3: 回帰テスト `packages/web-ui/test/grid-overlay-offset.test.ts`（依存: T1）
- [x] T4: build / lint / web-ui スイート（依存: T1-T3）
- [x] T5: 実機で実ブラウザ計測 `scripts/verify-cursor-align.mjs`（依存: T4）＋ `scripts/README.md` へ記載
