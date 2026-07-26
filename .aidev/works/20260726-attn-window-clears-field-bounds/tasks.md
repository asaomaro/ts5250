# タスク: 表示属性の終端境界をフォーマットテーブルから独立させる

- [x] T1: 回帰テスト `packages/core/test/screen-buffer-attr-bounds.test.ts` を書き、**現状で落ちること**を確認
- [x] T2: `ScreenBuffer.attrBounds`（開始→終端の Map）を追加し、`addField` で記録・`clearUnit`/`resize` で消去。`clearFormatTable` では消さない
- [x] T3: `saveScreen` / `restoreScreen` に `attrBounds` のコピーを含める（依存: T2）
- [x] T4: `snapshot()` の `fieldEnds` を `attrBounds` から作る（依存: T2）
- [x] T5: `addField` で新フィールドの範囲に重なる古い境界を捨てる（依存: T2）
- [x] T6: `docs/PROTOCOL.md` 4.3 に「境界はフォーマットテーブルと独立」を追記（依存: T2）
- [x] T7: 全テスト・`npm run build`・`npm run build -w @as400web/web-ui` の通過を確認（依存: T2〜T5）
- [x] T8: 実機（WRKOBJPDM）で Attn の前後を撮り、背面の下線が伸びないこと・F1 ヘルプが従来どおりを確認（依存: T7）
