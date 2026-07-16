import type { Cell, Field } from "@as400web/core";
import { fieldSpan, offsetOfPos } from "./fieldSlices.js";

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

/**
 * pos の方向 dir にある「語頭」セルへ移動する（ACS の Ctrl+矢印 頭出し）。
 * 語 = 非空白セルの連なり。入力欄・保護テキストを問わず、表示文字だけで判定する
 * （例: `TEXT1  ␣  TEXT2` の空白にカーソルがあるとき Ctrl+→ で TEXT2 の先頭 T へ）。
 * 語頭 = 非空白かつ「行頭 or 左隣が空白」のセル（全角後半 dbcs-tail は語頭にしない）。
 * - left/right: 読み順（行→桁、行をまたぐ）で前後の語頭へ。
 * - up/down: **同じ列位置のまま**、上/下方向で最も近い非空白セルへ（空白列はスキップ）。
 *   例: `ABCDEFG`/`HIJ LMN`/`OPQxSTU` の x(3行4列)で Ctrl+↑ → 空白の 2 行 4 列を飛ばし 1 行 4 列 D へ。
 * 見つからなければ pos を返す（画面端で停止）。cells は [row-1][col-1] の 0 始まりグリッド。
 */
export function nextWordStart(cells: readonly Cell[][], pos: Pos, dir: Dir, rows: number, cols: number): Pos {
  const isBlank = (r: number, c: number): boolean => {
    const ch = cells[r]?.[c]?.char;
    return ch === undefined || ch === "" || ch === " ";
  };
  const isWordStart = (r: number, c: number): boolean => {
    if (isBlank(r, c)) return false;
    if (cells[r]?.[c]?.kind === "dbcs-tail") return false; // 全角後半は語頭にしない
    return c === 0 || isBlank(r, c - 1);
  };
  if (dir === "left" || dir === "right") {
    const idx = (pos.row - 1) * cols + (pos.col - 1);
    const max = rows * cols;
    if (dir === "right") {
      for (let i = idx + 1; i < max; i++) {
        if (isWordStart(Math.floor(i / cols), i % cols)) return { row: Math.floor(i / cols) + 1, col: (i % cols) + 1 };
      }
    } else {
      for (let i = idx - 1; i >= 0; i--) {
        if (isWordStart(Math.floor(i / cols), i % cols)) return { row: Math.floor(i / cols) + 1, col: (i % cols) + 1 };
      }
    }
    return pos;
  }
  // up/down: 同一列で、空白をスキップして最も近い非空白セルへ（列位置は保つ）。
  // 全角セル（lead/tail）は「内容あり」とし、tail に載ったら lead へ丸める。
  const col0 = pos.col - 1;
  const hasContent = (r: number): boolean => {
    const cell = cells[r]?.[col0];
    if (!cell) return false;
    if (cell.kind === "dbcs-lead" || cell.kind === "dbcs-tail") return true;
    return !isBlank(r, col0);
  };
  if (dir === "down") {
    for (let r = pos.row; r < rows; r++) {
      if (hasContent(r)) return roundToDbcsLead({ row: r + 1, col: pos.col }, cells);
    }
  } else {
    for (let r = pos.row - 2; r >= 0; r--) {
      if (hasContent(r)) return roundToDbcsLead({ row: r + 1, col: pos.col }, cells);
    }
  }
  return pos; // 端で停止
}

/**
 * (row,col) を含むフィールドを返す（無ければ undefined）。
 * 行またぎフィールド（コマンド行等）は折返し先の行も対象になる（fieldSlices と同じ規則）。
 */
export function fieldAt(
  row: number,
  col: number,
  fields: readonly Field[],
  cols: number,
  rows: number
): Field | undefined {
  return fields.find((f) => offsetOfPos(f, row, col, cols, rows) !== undefined);
}

/**
 * フィールド先頭からの桁オフセット（＝入力欄のキャレット位置）。
 * 折返し先の行では前行までの桁数が加算される。フィールド外は 0〜span にクランプ。
 */
export function caretInField(field: Field, row: number, col: number, cols: number, rows: number): number {
  const off = offsetOfPos(field, row, col, cols, rows);
  if (off !== undefined) return off;
  // 欄外: 手前なら 0、末尾より後ろなら span（末尾の直後＝右端境界）
  const span = fieldSpan(field, cols, rows);
  const addr = (row - 1) * cols + (col - 1);
  const start = (field.row - 1) * cols + (field.col - 1);
  return Math.max(0, Math.min(addr - start, span));
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
