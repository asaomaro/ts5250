import type { Field } from "@as400web/core";

/** フィールドの表示スライス（1 行ぶんの矩形）。 */
export interface FieldSlice {
  row: number;
  col: number;
  /** この行に表示する桁数 */
  width: number;
  /** フィールド先頭からの論理オフセット */
  offset: number;
}

/**
 * フィールドを行ごとの表示スライスへ分解する。
 *
 * 5250 のフィールドは画面バッファ上の連続領域なので、行末を超える分は次行の 1 桁目へ折り返す
 * （例: コマンド行 (20,7) len=153 は row20 col7 から 74 桁＋row21 col1 から 79 桁）。
 * 編集モデルはこの全スライスを 1 つの論理フィールドとして扱い、表示だけを行ごとに割る。
 *
 * DBCS 欄は当面 1 行目のみ（SO/SI 列ビューとの合流・行境界を跨ぐ全角の扱いが要るため次段で対応）。
 */
export function fieldSlices(f: Field, cols: number, rows: number): FieldSlice[] {
  const first = Math.min(f.length, Math.max(0, cols - (f.col - 1)));
  const out: FieldSlice[] = [{ row: f.row, col: f.col, width: first, offset: 0 }];
  if (f.dbcsType !== undefined) return out; // DBCS 欄の行またぎは未対応
  let offset = first;
  let r = f.row + 1;
  while (offset < f.length && r <= rows) {
    const width = Math.min(f.length - offset, cols);
    out.push({ row: r, col: 1, width, offset });
    offset += width;
    r++;
  }
  return out;
}

/** 編集モデルが扱う論理桁数（全スライスの合計）。画面に収まらない分は落とす。 */
export function fieldSpan(f: Field, cols: number, rows: number): number {
  const s = fieldSlices(f, cols, rows);
  const last = s[s.length - 1]!;
  return last.offset + last.width;
}

/** 論理オフセット → 画面位置。span を超える位置は末尾の直後（欄の右端境界）を返す。 */
export function posOfOffset(f: Field, offset: number, cols: number, rows: number): { row: number; col: number } {
  const slices = fieldSlices(f, cols, rows);
  for (const s of slices) {
    if (offset < s.offset + s.width) return { row: s.row, col: s.col + (offset - s.offset) };
  }
  const last = slices[slices.length - 1]!;
  return { row: last.row, col: last.col + last.width };
}

/** 画面位置 → 論理オフセット（フィールド外なら undefined）。 */
export function offsetOfPos(
  f: Field,
  row: number,
  col: number,
  cols: number,
  rows: number
): number | undefined {
  for (const s of fieldSlices(f, cols, rows)) {
    if (row === s.row && col >= s.col && col < s.col + s.width) return s.offset + (col - s.col);
  }
  return undefined;
}
