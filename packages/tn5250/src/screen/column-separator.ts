import type { Cell } from "./types.js";

/**
 * **桁区切り（DSPATR(CS)）の見せ方**——ACS「表示 > 表示 > 桁区切り文字」と同じ 3 値。
 *
 * - `dot`  … 桁の境目の下端に短い点（ACS の既定）。入力欄の下線に点が並び、桁数が読める
 * - `line` … 桁の境目に縦線（行の高さいっぱい）
 * - `off`  … 出さない
 *
 * 描き方は ACS の `ScreenText`（桁ごとに右端へ 1 本、連なりの頭は左端にも 1 本）に合わせる。
 * 以前は連なりの頭に `border-left` を 1 本引くだけで、桁の区切りになっていなかった。
 */
export type ColumnSeparatorStyle = "dot" | "line" | "off";

/** 桁区切りの連なり 1 つ（1 始まりの行・桁と、桁数） */
export interface ColumnSeparatorRun {
  row: number;
  col: number;
  len: number;
}

/**
 * 画面から**桁区切りの連なり**を拾う。描く側（web-ui の画面・HTML 書き出し）はこの結果に
 * 「連なりの頭の左端＋各桁の右端」の `len + 1` 本を引く。
 *
 * **連なりの算出を 1 か所に置く**のは、画面と保存 HTML で区切りの位置が食い違わないようにするため
 * （片方だけ直して絵がずれる、を避ける）。
 *
 * 属性桁は `columnSeparator: false`（`buffer.ts`）なので連なりはそこで切れる。
 * ACS は属性桁自身にも印を持ち、その右端＝欄の 1 桁目の左端に線を引くが、
 * それは「連なりの頭の左端」と同じ位置なので結果は変わらない。
 */
export function columnSeparatorRuns(cells: readonly (readonly Cell[])[]): ColumnSeparatorRun[] {
  const out: ColumnSeparatorRun[] = [];
  cells.forEach((row, r) => {
    let start = -1;
    for (let c = 0; c <= row.length; c++) {
      const on = c < row.length && row[c]!.columnSeparator;
      if (on && start < 0) start = c;
      if (!on && start >= 0) {
        out.push({ row: r + 1, col: start + 1, len: c - start });
        start = -1;
      }
    }
  });
  return out;
}
