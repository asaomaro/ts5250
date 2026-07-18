# タスク: PDF 出力先を保存時に検証する

- [x] T1: `output-dir.ts` に `checkOutputDir` を実装
- [x] T2: `output-dir.test.ts`（5 パターン）（依存: T1）
- [x] T3: `app.ts` の保存 2 ルートに配線・400・`resolvedPdfDir`（依存: T1）
- [x] T4: ルートのテスト（400 で未保存・成功時に絶対パス）（依存: T3）
- [x] T5: UI にインライン表示（依存: T3）
- [x] T6: README 追記（依存: T3）
- [x] T7: 全体検証（依存: T4,T5,T6）
