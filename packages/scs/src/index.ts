/**
 * `@as400web/scs` の入口。IBM i のスプール（印刷データ）のバイト列を論理ページに展開する。
 *
 * 依存は `@as400web/ebcdic` のみ——TN5250 のプロトコル一式を引き込まずに、
 * 「スプールを読んで帳票にする」用途だけを満たす。
 */
export { ScsDecoder, type LogicalPage } from "./scs.js";
