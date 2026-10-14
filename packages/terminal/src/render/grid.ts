/**
 * DDS のグリッド罫線（GRDATR / GRDLIN。`ScreenSnapshot.gui.gridLines`）を、端末のセルの罫線文字へ置く純関数。
 *
 * ホストの罫線は**セルの境界**に引かれる（web-ui は CSS の境界線で描く）が、文字端末は境界に線を引けない。
 * そこで 1 本の線を、その線の持ち主のセル（上辺・内部の横罫・左辺・内部の縦罫は境界の下・右のセル、下辺・右辺は上・左のセル）の
 * 中央を通る罫線文字（─ │ ┌ ┐ └ ┘ ├ ┤ ┬ ┴ ┼）に置き換える。線の端は内向きだけの腕にして、箱の角が ┌ ┐ └ ┘ になる。
 * 文字の入っているセルは文字を優先し（線は隠れる）、空白のセルにだけ線を描く。
 *
 * 幾何（持ち主・内部罫線の間隔・窓の穴）は web-ui `ScreenGrid.vue` の `gridSegments` と同じ規則（実機で確かめた結果が注記にある）。
 * 色と線種は ACS に合わせず、ホストの指定どおりにする（`gridSegments` の注記。利用者の判断）。
 * 端末が出せない線種は近い字へ寄せる: 太字・二重・点線・破線は専用の字、二重破線は二重線。
 */
import type { GuiGridLine, GuiWindow, ScreenColor, ScreenSnapshot } from "@ts5250/tn5250";
import { GRID_COLOR } from "@ts5250/tn5250";
import { decodeAttribute } from "@ts5250/tn5250/browser";
import { isFullWidth } from "@ts5250/base";

const N = 1, E = 2, S = 4, W = 8;

/** 腕の組（N=1 E=2 S=4 W=8）→ 罫線文字 */
const LIGHT = " ╵╶└╷│┌├╴┘─┴┐┤┬┼";
const HEAVY = " ╹╺┗╻┃┏┣╸┛━┻┓┫┳╋";
const DOUBLE = " ║═╚║║╔╠═╝═╩╗╣╦╬";

type Style = "light" | "heavy" | "double" | "dotted" | "dashed";

function styleOf(code: number): Style {
  switch (code) {
    case 0x01: return "heavy";
    case 0x02: case 0x0a: return "double";
    case 0x03: return "dotted";
    case 0x08: return "dashed";
    case 0x09: return "heavy";
    default: return "light";
  }
}

function glyph(mask: number, style: Style): string {
  const table = style === "heavy" ? HEAVY : style === "double" ? DOUBLE : LIGHT;
  const c = table[mask] ?? " ";
  if (style === "dotted") return c === "─" ? "┄" : c === "│" ? "┆" : c;
  if (style === "dashed") return c === "─" ? "╌" : c === "│" ? "╎" : c;
  return c;
}

export interface GridCell {
  ch: string;
  color: ScreenColor;
  /** 反転（反転表示の空白で枠を描く窓。`WDWBORDER` の `DSPATR(RI)`） */
  reverse?: boolean;
  /** 窓の枠・見出し。文字のあるセルも上書きする（窓は背面の上に乗る） */
  force?: boolean;
  /** 全角の字の左半分／右半分 */
  half?: "lead" | "tail";
}

/** 罫線の置き場。キーは `row * 1000 + col`（1 始まり）。空なら `undefined` */
export function gridOverlay(snap: ScreenSnapshot): Map<number, GridCell> | undefined {
  const lines = snap.gui?.gridLines ?? [];
  const windows = snap.gui?.windows ?? [];
  if (lines.length === 0 && windows.length === 0) return undefined;
  const acc = new Map<number, { mask: number; style: Style; color: ScreenColor }>();
  const add = (row: number, col: number, bits: number, style: Style, color: ScreenColor): void => {
    if (row < 1 || col < 1 || row > snap.rows || col > snap.cols) return;
    const k = row * 1000 + col;
    const cur = acc.get(k);
    acc.set(k, { mask: (cur?.mask ?? 0) | bits, style: cur ? cur.style : style, color: cur ? cur.color : color });
  };
  for (const g of lines) segmentsOf(g, add);
  const out = new Map<number, GridCell>();
  for (const [k, v] of acc) out.set(k, { ch: glyph(v.mask, v.style), color: v.color });
  for (const w of windows) windowCells(w, snap, out);
  return out.size > 0 ? out : undefined;
}

type Add = (row: number, col: number, bits: number, style: Style, color: ScreenColor) => void;

function segmentsOf(g: GuiGridLine, add: Add): void {
  const style = styleOf(g.lineStyle);
  // 色は属性バイトではなく専用のコード。表にない値（既定色 0xFF 含む）は白
  const named = GRID_COLOR[g.color] ?? "white";
  const color: ScreenColor = (["green", "white", "red", "turquoise", "yellow", "pink", "blue"] as const).find((c) => c === named) ?? "white";
  const top = g.row - 1, left = g.col - 1;
  const bottom = top + Math.max(1, g.height), right = left + Math.max(1, g.width);
  const holes = g.holes ?? [];

  /** 区間 [a, b)（境界の番号）から、持ち主が穴に入るときの穴の範囲を除いた残り */
  const cut = (a: number, b: number, owner: number, vertical: boolean): [number, number][] => {
    let pieces: [number, number][] = [[a, b]];
    for (const h of holes) {
      const inOwner = vertical ? owner >= h.col && owner < h.col + h.width : owner >= h.row && owner < h.row + h.height;
      if (!inOwner) continue;
      const s = vertical ? h.row - 1 : h.col - 1;
      const e = s + (vertical ? h.height : h.width);
      pieces = pieces.flatMap(([x, y]): [number, number][] => [
        ...(x < Math.min(y, s) ? [[x, Math.min(y, s)] as [number, number]] : []),
        ...(Math.max(x, e) < y ? [[Math.max(x, e), y] as [number, number]] : [])
      ]);
    }
    return pieces;
  };
  /** 境界 `bound` の横罫。持ち主の行は、上辺・内部は下の行、下辺は上の行。区間のセルは桁 x+1..y */
  const hAt = (bound: number, ownerBelow: boolean): void => {
    const owner = ownerBelow ? bound + 1 : bound;
    for (const [x, y] of cut(left, right, owner, false)) {
      for (let c = x + 1; c <= y; c++) {
        const bits = x + 1 === y ? E | W : c === x + 1 ? E : c === y ? W : E | W;
        add(owner, c, bits, style, color);
      }
    }
  };
  /** 境界 `bound` の縦罫。持ち主の桁は、左辺・内部は右の桁、右辺は左の桁。区間のセルは行 x+1..y */
  const vAt = (bound: number, ownerRight: boolean): void => {
    const owner = ownerRight ? bound + 1 : bound;
    for (const [x, y] of cut(top, bottom, owner, true)) {
      for (let r = x + 1; r <= y; r++) {
        const bits = x + 1 === y ? N | S : r === x + 1 ? S : r === y ? N : N | S;
        add(r, owner, bits, style, color);
      }
    }
  };
  if (g.minorType <= 0x03) {
    const repeat = Math.max(1, g.value1);
    const interval = Math.max(1, g.value2);
    const horizontal = g.minorType <= 0x01;
    const base = g.minorType === 0x00 ? top : g.minorType === 0x01 ? bottom : g.minorType === 0x02 ? left : right;
    const below = g.minorType === 0x00 || g.minorType === 0x02;
    for (let i = 0; i < repeat; i++) {
      const at = base + i * interval;
      if (horizontal) hAt(at, below);
      else vAt(at, below);
    }
    return;
  }
  hAt(top, true);
  hAt(bottom, false);
  vAt(left, true);
  vAt(right, false);
  if ((g.minorType === 0x05 || g.minorType === 0x07) && g.value1 > 0) {
    for (let b = top + g.value1; b < bottom; b += g.value1) hAt(b, true);
  }
  if ((g.minorType === 0x06 || g.minorType === 0x07) && g.value2 > 0) {
    for (let b = left + g.value2; b < right; b += g.value2) vAt(b, true);
  }
}

/** ScreenColor に落とす（属性バイトのデコード結果は同じ名前の色） */
const asColor = (c: string): ScreenColor => (["green", "white", "red", "turquoise", "yellow", "pink", "blue"] as const).find((x) => x === c) ?? "green";

/**
 * 窓の枠（WDWBORDER）と見出し（WDWTITLE）。**枠は窓の外側**で、行 `row`〜`row+height+1`・桁 `col+1`〜`col+width+4`
 * （ホストが送る位置は枠の左上で、属性の桁を 1 つ含む。web-ui `hostBorderRows`・`hostBorderSegments` と同じ）。
 * 文字の指定があれば**属性ごと**その字で描く（反転の空白 8 個なら背景色のセルの枠）。無ければ線の枠にする。
 * 窓は背面の上に乗るので、枠も見出しも下の文字を上書きする。
 */
function windowCells(w: GuiWindow, snap: ScreenSnapshot, out: Map<number, GridCell>): void {
  const put = (row: number, col: number, c: GridCell): void => {
    if (row < 1 || col < 1 || row > snap.rows || col > snap.cols) return;
    out.set(row * 1000 + col, { ...c, force: true });
  };
  const bottom = w.row + w.height + 1;
  const left = w.col + 1;
  const right = w.col + w.width + 4;
  const b = w.border;
  if (b) {
    const a = decodeAttribute(b.cba);
    const base = { color: asColor(a.color), ...(a.reverse ? { reverse: true } : {}) };
    const c = b.chars;
    for (let col = left; col <= right; col++) {
      const first = col === left, last = col === right;
      put(w.row, col, { ...base, ch: c ? (first ? c.ulbc : last ? c.urbc : c.tbc) : first ? "┌" : last ? "┐" : "─" });
      put(bottom, col, { ...base, ch: c ? (first ? c.llbc : last ? c.lrbc : c.bbc) : first ? "└" : last ? "┘" : "─" });
    }
    for (let row = w.row + 1; row < bottom; row++) {
      put(row, left, { ...base, ch: c ? c.lbc : "│" });
      put(row, right, { ...base, ch: c ? c.rbc : "│" });
    }
  }
  const t = w.title;
  if (t) {
    const cells = w.width + 4;
    const row = t.footer ? bottom : w.row;
    const width = [...t.text].reduce((n, ch) => n + (isFullWidth(ch) ? 2 : 1), 0);
    const pad = Math.max(0, cells - width);
    const off = t.align === "left" ? 0 : t.align === "right" ? pad : Math.floor(pad / 2);
    const a = decodeAttribute(t.cba);
    const base = { color: asColor(a.color), ...(a.reverse ? { reverse: true } : {}) };
    let col = w.col + off + 1;
    for (const ch of t.text) {
      if (isFullWidth(ch)) {
        put(row, col, { ...base, ch, half: "lead" });
        put(row, col + 1, { ...base, ch: "", half: "tail" });
        col += 2;
      } else {
        put(row, col, { ...base, ch });
        col += 1;
      }
    }
  }
}
