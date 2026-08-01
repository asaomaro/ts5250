/**
 * `@as400web/scs` の入口。IBM i のスプール（印刷データ）のバイト列を論理ページに展開する。
 *
 * 依存は `@as400web/ebcdic` のみ——TN5250 のプロトコル一式を引き込まずに、
 * 「スプールを読んで帳票にする」用途だけを満たす。
 */
export { ScsDecoder, type LogicalPage } from "./scs.js";

/**
 * 論理ページ → 自己完結 HTML（帳票のプレビュー・印刷）。
 *
 * **バイト列 → 論理ページ の自然な続き**なのでここに置く。分割前は
 * `@as400web/tn5250`（TN5250）に居たが、スプールは 5250 の端末プロトコルと無関係で、
 * 「core は何でも入っている袋」の一例だった（`20260801-library-extraction-tn5250`）。
 *
 * `@as400web/base` の `isFullWidth` を使う（桁を数える側と描く側で表を分けないため）。
 * `document.*` が現れるのは**生成する HTML の中身**であって、このモジュール自身は
 * `node:*` にも DOM にも触れない（`tsconfig` の `types: []` が保証している）。
 */
export { renderSpoolHtml, type SpoolHtmlMeta } from "./spool-html.js";
