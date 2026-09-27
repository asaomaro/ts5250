# 調査: 空ページ

## 判明した事実
- F1（原典 `PrintSCS5250JPS.processFormFeed`）: FF ごとに、そのときのコマンド列を `JPSPage` として `m_pages` に積み、`JPSInitialize` から始め直す。中身の有無は見ない。
- F2（当 PJ）: `scs.ts` の `flushPage` は `maxRow === 0 && maxCol === 0` なら出さない（FF でも・帳票の終わりでも）。FF だけの帳票は 0 ページで、PDF は 0 ページのとき白紙を 1 枚作る（`packages/server/src/pdf.ts` の `list`）。
- F3（実機の帳票）: 手元の実採取（`packages/scs/test/fixtures/scs-print-*.bin`）は FF がページの終わりにある（先頭には無い）。FF が続く帳票・先頭の FF は実採取に無い（頻度は未確認）。
- F4（ACS の実出力）: 未実測（ヘッドレスの ACS のプリンターは通信の開始から戻らない。`20260927-ff-report-acs-output`）。原典だけ。

## 実装アンカー
- A1: `packages/scs/src/scs.ts` `flushPage`・`case FF`
