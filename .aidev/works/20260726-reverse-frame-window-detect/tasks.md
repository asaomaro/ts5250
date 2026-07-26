# タスク: 反転表示で閉じた矩形を窓として判定する

- [x] T1: 回帰テスト `packages/web-ui/test/reverse-frame-window.test.ts` を書き、現状で Attn 窓が判定されないことを確認
- [x] T2: `reverseRuns` / `detectReverseFrame` を実装し `detectWindowRect` の第 3 経路に繋ぐ（依存: T1）
- [x] T3: 弾く形のテスト（上下バーだけ／側面が途切れる／幅不足／上下端の不一致）（依存: T2）
- [x] T4: 既存経路（罫線・`gui.windows`）が変わらないことをテストで固定（依存: T2）
- [x] T5: 全テスト・`npm run build -w @as400web/web-ui`（vue-tsc 込み）の通過（依存: T2〜T4）
- [x] T6: 実機で Attn の窓が判定され、窓の凡例がボタンになり背面の凡例が出ないことを確認（依存: T5）
- [x] T7: 実機で反転を多用する画面（SEU・UPDDTA・サブファイル）を回り誤検出が無いことを確認（依存: T5）
