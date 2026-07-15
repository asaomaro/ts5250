import type { Cell, Field } from "@as400web/core";

/**
 * 画面全体の自由カーソルの移動・判定（DOM 非依存の純関数）。
 * カーソルは 1 始まりの (row, col)。固定等幅グリッド前提。
 */

export type Dir = "up" | "down" | "left" | "right";
export interface Pos {
  row: number;
  col: number;
}

/**
 * カーソルを 1 セル移動する。
 * - left/right: 桁送り。行頭で left は前行末尾へ、行末で right は次行先頭へ（画面端はクランプ）。
 * - up/down: 同じ桁で行移動（画面端はクランプ）。
 */
export function moveCursor(cur: Pos, dir: Dir, rows: number, cols: number): Pos {
  let { row, col } = cur;
  switch (dir) {
    case "left":
      col -= 1;
      if (col < 1) {
        if (row > 1) {
          row -= 1;
          col = cols;
        } else {
          col = 1;
        }
      }
      break;
    case "right":
      col += 1;
      if (col > cols) {
        if (row < rows) {
          row += 1;
          col = 1;
        } else {
          col = cols;
        }
      }
      break;
    case "up":
      row = Math.max(1, row - 1);
      break;
    case "down":
      row = Math.min(rows, row + 1);
      break;
  }
  return { row, col };
}

/** (row,col) を含むフィールドを返す（単一行に収まる範囲で判定。無ければ undefined）。 */
export function fieldAt(row: number, col: number, fields: readonly Field[]): Field | undefined {
  return fields.find((f) => f.row === row && col >= f.col && col < f.col + f.length);
}

/** フィールド先頭からの桁オフセット（＝入力欄のキャレット位置）。0〜length にクランプ。 */
export function caretInField(field: Field, col: number): number {
  return Math.max(0, Math.min(col - field.col, field.length));
}

/**
 * DBCS 文字の後半桁（dbcs-tail）にカーソルが載ったら前半（lead）桁へ丸める。
 * 全角 1 文字は 2 桁を占め、桁間にはカーソルを置けない（ACS/実 5250 準拠）。
 * cells は [row-1][col-1] の 0 始まりグリッド。範囲外・非 DBCS はそのまま返す。
 */
export function roundToDbcsLead(pos: Pos, cells: readonly Cell[][]): Pos {
  const cell = cells[pos.row - 1]?.[pos.col - 1];
  if (cell?.kind === "dbcs-tail" && pos.col > 1) return { row: pos.row, col: pos.col - 1 };
  return pos;
}
