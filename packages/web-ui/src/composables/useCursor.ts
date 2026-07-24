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
 * pos の方向 dir にある「語頭」桁へ移動する（ACS の Ctrl+矢印 頭出し）。
 * 語 = 非空白桁の連なり。入力欄・保護テキストを問わず、表示文字だけで判定する
 * （例: `TEXT1  ␣  TEXT2` の空白にカーソルがあるとき Ctrl+→ で TEXT2 の先頭 T へ）。
 * 語頭 = 非空白かつ「行頭 or 左隣が空白」の桁。
 * - left/right: 読み順（行→桁、行をまたぐ）で前後の語頭へ。
 * - up/down: **同じ列位置のまま**、上/下方向で最も近い非空白桁へ（空白列はスキップ）。
 *   例: `ABCDEFG`/`HIJ LMN`/`OPQxSTU` の x(3行4列)で Ctrl+↑ → 空白の 2 行 4 列を飛ばし 1 行 4 列 D へ。
 * 見つからなければ pos を返す（画面端で停止）。
 *
 * **セルではなく桁アクセサを取る**のは `wordRangeAt` と同じ理由——入力欄の桁は
 * **未送信の入力値**を持ちうる（cells はホストが描いた内容しか持たない）。セルで判定すると、
 * 欄に打った文字が語として見えず飛び越される（`X   あ Y` の あ を打った直後に Ctrl+→ すると
 * あ を飛ばして Y へ行っていた）。
 *
 * charAt(row, col) の約束: `" "` = 空白（SO/SI 含む）、`""` = 全角の後半桁（＝語の続き）、他 = 文字。
 * `""` を空白と見なすと DBCS の語の中で 1 文字ずつ止まってしまうので、**空白ではないが語頭でもない**
 * として扱う。
 */
export function nextWordStart(
  charAt: (row: number, col: number) => string,
  pos: Pos,
  dir: Dir,
  rows: number,
  cols: number
): Pos {
  const isBlank = (r: number, c: number): boolean => charAt(r, c) === " ";
  const isWordStart = (r: number, c: number): boolean => {
    const ch = charAt(r, c);
    if (ch === " " || ch === "") return false;
    return c === 1 || isBlank(r, c - 1);
  };
  if (dir === "left" || dir === "right") {
    const at = (i: number): Pos => ({ row: Math.floor(i / cols) + 1, col: (i % cols) + 1 });
    const idx = (pos.row - 1) * cols + (pos.col - 1);
    const max = rows * cols;
    if (dir === "right") {
      for (let i = idx + 1; i < max; i++) {
        const p = at(i);
        if (isWordStart(p.row, p.col)) return p;
      }
    } else {
      for (let i = idx - 1; i >= 0; i--) {
        const p = at(i);
        if (isWordStart(p.row, p.col)) return p;
      }
    }
    return pos;
  }
  // up/down: 同一列で、空白をスキップして最も近い内容のある桁へ（列位置は保つ）。
  // 全角の後半桁（""）に載ったら前半（lead）へ丸める。
  const toLead = (p: Pos): Pos => (charAt(p.row, p.col) === "" ? { row: p.row, col: p.col - 1 } : p);
  const hasContent = (r: number): boolean => charAt(r, pos.col) !== " ";
  if (dir === "down") {
    for (let r = pos.row + 1; r <= rows; r++) if (hasContent(r)) return toLead({ row: r, col: pos.col });
  } else {
    for (let r = pos.row - 1; r >= 1; r--) if (hasContent(r)) return toLead({ row: r, col: pos.col });
  }
  return pos; // 端で停止
}

/**
 * col を含む「語」の桁範囲（1 始まり・両端含む）。空白桁なら undefined（ダブルクリック選択用）。
 * 語 = 非空白桁の連なり（nextWordStart と同じ定義）。行はまたがない。
 *
 * セルではなく桁アクセサを取るのは、入力欄の桁が「未送信の入力値」を持ちうるため
 * （cells はホストが描いた内容しか持たない）。コピーと同じ文字で語を切るために、
 * 呼び出し側はコピーと同じアクセサを渡す。
 * charAt(col) の約束: " " = 空白（SO/SI 含む）、"" = 全角の後半桁（＝語の続き）、他 = 文字。
 */
export function wordRangeAt(
  charAt: (col: number) => string,
  cols: number,
  col: number
): { c1: number; c2: number } | undefined {
  const isWord = (c: number): boolean => c >= 1 && c <= cols && charAt(c) !== " ";
  if (!isWord(col)) return undefined;
  let c1 = col;
  while (isWord(c1 - 1)) c1--;
  let c2 = col;
  while (isWord(c2 + 1)) c2++;
  return { c1, c2 };
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
