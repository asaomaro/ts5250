# 仕様: 空ページ

## 設計方針
`flushPage(keepEmpty)`: FF からは `true`（空でも出す）、帳票の終わりからは従来どおり空なら出さない。

## 依拠する既存の事実
- research F1・F2。描画: `renderSpoolHtml`・`renderSpoolPdf` は行 0 のページを描ける（実際に描いて確かめた。PDF は 3 ページ）

## 受け入れ基準との対応
- AC1: `packages/scs/test/scs.test.ts` と描画の確認（test-result）
