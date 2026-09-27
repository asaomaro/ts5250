import type { Cell, Field } from "@ts5250/tn5250";

/**
 * **SOH のフラグ 0x10（DDS の `CSRINPONLY`）: 矢印で入力欄の外へ出たら、入力欄へ寄せる**（ACS `FFT5250.moveCursorToInput`。`20260927-key-edit-rest`）。
 *
 * ACS は矢印（1004〜1007）でカーソルが**入力欄（非バイパス）の外**に着いたときだけ、行き先を寄せる:
 * - 左: その行の頭から着いた桁までにある入力欄の、いちばん右の桁（`scanCursorable` の後ろ向き）。無ければ前の行の全体（行 1 から最終行へ巡回）
 * - 右: 着いた桁から行末までにある入力欄の、いちばん左の桁。無ければ次の行の全体（最終行から行 1 へ巡回）
 * - 上・下: 着いた行で左右の候補を探し、**番地の差**で近い方（右が `右 − 着いた番地 ≤ 着いた番地 − 左` なら右）。無ければ上（下）の行へ、桁はそのままで繰り返す。
 *   差は着いた番地から測るので、行を移った後の候補では右側の差が負になって右が選ばれる（実機の ACS のコア: 9,20 から上で 5,40——5,15 の方が近いのに）
 * - 着いた桁が SO（O 欄でない）なら 1 つ進め、全角の 2 バイト目なら 1 つ戻す
 * 実機の ACS のコア（`scripts/acs-probe/csr-input-only.txt`）と同じ結果になる。
 */
export type ArrowDir = "left" | "right" | "up" | "down";

interface Span {
  start: number;
  end: number;
}

export function snapToInput(
  dir: ArrowDir,
  at: { row: number; col: number },
  fields: readonly Field[],
  cells: readonly (readonly Cell[])[],
  rows: number,
  cols: number
): { row: number; col: number } {
  const spans: Span[] = fields
    .filter((f) => !f.protected)
    .map((f) => {
      const start = (f.row - 1) * cols + (f.col - 1);
      return { start, end: start + f.length - 1 };
    });
  const n = (at.row - 1) * cols + (at.col - 1);
  if (spans.some((s) => n >= s.start && n <= s.end)) return at;
  // `scanCursorable`: 行 r の、前向きなら桁 c から行末・後ろ向きなら行頭から桁 c まで。欄の並びの前から（後ろ向きは後ろから）最初に重なる欄
  const scan = (r: number, c: number, forward: boolean): number => {
    const lo = forward ? r * cols + c : r * cols;
    const hi = forward ? (r + 1) * cols - 1 : r * cols + c;
    const list = forward ? spans : [...spans].reverse();
    for (const s of list) if (hi >= s.start && lo <= s.end) return forward ? Math.max(lo, s.start) : Math.min(hi, s.end);
    return -1;
  };
  let r = Math.floor(n / cols);
  let c = n % cols;
  let to = 0;
  if (dir === "left") {
    for (let i = rows + 1; i > 0; i--) {
      const x = scan(r, c, false);
      if (x >= 0) { to = x; break; }
      c = cols - 1;
      r = r === 0 ? rows - 1 : r - 1;
    }
  } else if (dir === "right") {
    for (let i = rows + 1; i > 0; i--) {
      const x = scan(r, c, true);
      if (x >= 0) { to = x; break; }
      c = 0;
      r = r + 1 === rows ? 0 : r + 1;
    }
  } else {
    for (let i = rows; i > 0; i--) {
      const left = scan(r, c, false);
      if (left >= 0) {
        const right = scan(r, c, true);
        to = right >= 0 && right - n <= n - left ? right : left;
        break;
      }
      const right = scan(r, c, true);
      if (right >= 0) { to = right; break; }
      r = dir === "up" ? (r === 0 ? rows - 1 : r - 1) : r + 1 === rows ? 0 : r + 1;
    }
  }
  let row = Math.floor(to / cols) + 1;
  let col = (to % cols) + 1;
  const kind = cells[row - 1]?.[col - 1]?.kind;
  const f = fields.find((x) => !x.protected && x.row === row && col >= x.col && col < x.col + x.length);
  if (kind === "so" && f?.dbcsType !== "open") col += 1;
  else if (kind === "dbcs-tail") col -= 1;
  if (col > cols) { col = 1; row = row === rows ? 1 : row + 1; }
  return { row, col };
}
