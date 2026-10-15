/**
 * ScreenSnapshot → 端末の行（ANSI 文字列）。**純関数**（Node API 非依存。tty への書き込みは `transport/`）。
 *
 * 設計の要点（`.aidev/works/20261014-terminal-ui` research F1〜F8）:
 * - 5250 の 1 桁 = 端末の 1 桁。全角は lead が 2 桁を取り、tail は描かない。
 * - **非 ASCII の 1 字ごとに桁を絶対位置（CHA）で固定する**。端末と 5250 で曖昧幅の解釈が食い違っても、
 *   ずれが 1 字の内に閉じて行全体へ波及しない（tmux 3.4 は ○●★─│ を 1 桁で数えた＝実測）。
 * - 各行は CUP で始め、`\r\n` を使わない（桁ずれがスクロールに化けるのを避ける）。
 * - 下線・桁区切りは**画面定義（DDS）が決める**。`Cell.underline` が真なら下線、`Cell.columnSeparator` が真なら
 *   点線の下線（SGR 4:4）。端末側で代替の見せ方（縞・中点埋め）は足さない（利用者の判断）。
 */
import type { Cell, ScreenColor, ScreenSnapshot } from "@ts5250/tn5250";
import { gridOverlay, type GridCell } from "./grid.js";
import { PLAIN_VIEW, headerText, recodeByte, resolveSbcsView, type SbcsView, type TermView } from "../app/view.js";

export type ColorMode = "truecolor" | "256";

export interface FrameOptions {
  /** 端末の大きさ（桁・行）。5250 の画面 + 状態行の 1 行より小さければ左上を合わせて切る */
  viewport: { cols: number; rows: number };
  colorMode: ColorMode;
  /** 状態行に出す一言（操作の結果・エラーなど） */
  note?: string;
  /** カーソルの位置（1 始まり）。省略時はホストの指定 */
  cursor?: { row: number; col: number };
  /** 挿入モード（状態行に出す） */
  insert?: boolean;
  /** 画面表示の設定。省略時は素の見え方（ヘッダーなし。従来の描画と同じ） */
  view?: TermView;
  /** ホストの SBCS 表がカタカナ側（930/5026）か。表示コードの切替で読み直す向きを決める */
  hostKatakana?: boolean;
  /** ヘッダーの接頭キーの表記（`]` なら `Ctrl+]→`） */
  prefix?: string;
  /** ルーラーを引く位置（1 始まり）。`view.rule` が真のときだけ使う */
  ruleAt?: { row: number; col: number };
}

export interface Frame {
  /** 画面の行（0 起点で端末の行 1…）。最後が状態行 */
  rows: string[];
  /** 端末上のカーソル（1 始まり）。切り詰めで見えないときは undefined */
  cursor: { row: number; col: number } | undefined;
}

const RESET = "\x1b[0m";

const TRUE: Record<ScreenColor, string> = {
  green: "38;2;0;200;0",
  white: "38;2;230;230;230",
  red: "38;2;255;60;60",
  turquoise: "38;2;0;220;220",
  yellow: "38;2;240;220;0",
  pink: "38;2;255;100;200",
  blue: "38;2;90;120;255"
};
const C256: Record<ScreenColor, string> = {
  green: "38;5;40",
  white: "38;5;255",
  red: "38;5;203",
  turquoise: "38;5;51",
  yellow: "38;5;226",
  pink: "38;5;213",
  blue: "38;5;69"
};

/** セルの SGR（先頭の `0;` で前のセルの属性を引き継がない）。同じ並びのセルは呼び出し側がまとめる */
export interface SgrExtra {
  /** SO/SI マークを淡色で（`dim`） */
  dim?: boolean;
  /** ルーラーの帯（薄い背景色）。反転のセルには掛けない */
  tint?: boolean;
  /** 罫線の横罫を文字のあるセルへ重ねる（上線 SGR 53・下線 SGR 4） */
  edge?: "top" | "bottom" | "both";
}

export function sgrOf(c: Cell, mode: ColorMode, extra: SgrExtra = {}): string {
  const p = ["0", (mode === "truecolor" ? TRUE : C256)[c.color]];
  if (extra.dim) p.push("2");
  if (c.reverse) p.push("7");
  // 下線は DDS の指定（underline）。桁区切りだけのときは点線の下線（4:4）。両方なら実線を優先する
  if (c.underline || extra.edge === "bottom" || extra.edge === "both") p.push("4");
  else if (c.columnSeparator) p.push("4:4");
  if (extra.edge === "top" || extra.edge === "both") p.push("53");
  if (extra.tint && !c.reverse) p.push(mode === "truecolor" ? "48;2;40;48;72" : "48;5;236");
  if (c.blink) p.push("5");
  return `\x1b[${p.join(";")}m`;
}

/** そのセルが描く文字。非表示・属性桁・SO/SI は空白（桁は保つ）。ホストが「表せない」とした桁は塗りで示す（ACS も塗り潰し） */
function glyphOf(c: Cell): string {
  if (c.nonDisplay || c.kind === "attr" || c.kind === "so" || c.kind === "si") return " ";
  if (c.kind === "unmappable") return "▒";
  return c.char === "" ? " " : c.char;
}

const isAscii = (ch: string): boolean => ch.charCodeAt(0) < 0x7f && ch >= " ";

/** 画面 1 行を描く。`x0` は端末上の左端（1 始まり）、`maxCols` まで（超えた分は切る） */
interface RowCtx {
  /** 画面の行（1 始まり）。端末の行はヘッダーの分だけずれる */
  screenRow: number;
  termRow: number;
  maxCols: number;
  mode: ColorMode;
  grid?: Map<number, GridCell>;
  view: TermView;
  sbcs: SbcsView;
  ruleAt?: { row: number; col: number };
  /** この行に文字（空白以外）があるか */
  hasText: boolean;
  /** 下の行の上辺の横罫を、この行の下線として引くセル（キーは `row * 1000 + col`） */
  under: ReadonlySet<number>;
}

const hasTextIn = (cells: readonly Cell[]): boolean =>
  cells.some((c) => (c.kind === "sbcs" || c.kind === "dbcs-lead") && !c.nonDisplay && c.char !== "" && c.char !== " ");

function rowOf(cells: readonly Cell[], x: RowCtx): string {
  const { termRow, maxCols, mode, grid, view, sbcs } = x;
  const rowTint = view.rule && x.ruleAt !== undefined && view.ruleStyle !== "vertical" && x.ruleAt.row === x.screenRow;
  // 文字のある行では横罫を行の縁に引く（罫線文字 ─ は行の中ほどを通り、文字と同じ行に線が走って見える）。
  // 上辺の横罫は上の行の下線で引く（下線は端末が一様に対応する。上線 SGR 53 は先頭行など行が無いときだけ）
  const rowHasText = x.hasText;
  let out = `\x1b[${termRow};1H`;
  let last = "";
  let col = 1;
  let cellNo = 0;
  for (const src of cells) {
    cellNo++;
    let c = src;
    // DDS の罫線は、文字の無いセルにだけ罫線文字で描く（文字のあるセルは文字を優先）。窓の枠・見出しは背面の上に乗るので上書きする
    const g = grid?.get(x.screenRow * 1000 + cellNo);
    let edge: "top" | "bottom" | "both" | undefined;
    const hOnly = g !== undefined && g.hEdge !== undefined && g.mask !== undefined && (g.mask & 0b0101) === 0;
    if (g && hOnly && rowHasText && g.force !== true && !c.nonDisplay) {
      // 縁の線は空白のセルにも掛ける（下線は空白でも引かれる）。縦罫・角・交点は縁に置けないので下の分岐へ。
      // 上辺は、上線の設定ならこの行の上線、下線の設定なら上の行の下線が引く（先頭行だけは上線）
      if (g.hEdge === "bottom") edge = "bottom";
      else if (view.hrule === "over" || x.screenRow === 1) edge = "top";
    } else if (g && (g.force === true || ((c.kind === "sbcs" || c.kind === "attr") && (c.char === " " || c.char === "") && !c.nonDisplay))) {
      const kind = g.half === "lead" ? "dbcs-lead" : g.half === "tail" ? "dbcs-tail" : "sbcs";
      c = { ...c, kind, char: g.ch, color: g.color, reverse: g.reverse === true, underline: false, columnSeparator: false, nonDisplay: false };
    } else if (g && hOnly && c.kind !== "attr" && !c.nonDisplay) {
      // 文字のあるセルには縦罫も角も置けない。横罫だけは上線・下線で、文字を消さずに重ねる
      edge = g.hEdge;
    }
    if (x.under.has(x.screenRow * 1000 + cellNo) && !c.nonDisplay) edge = edge === "top" ? "both" : "bottom";
    let dim = false;
    if (!c.nonDisplay && (c.kind === "so" || c.kind === "si") && view.sosi !== "none") {
      c = { ...c, kind: "sbcs", char: c.kind === "so" ? "{" : "}" };
      dim = view.sosi === "dim";
    } else if (sbcs !== "host" && c.kind === "sbcs" && c.rawByte !== undefined) {
      c = { ...c, char: recodeByte(c.rawByte, sbcs) };
    }
    if (!view.colSep && c.columnSeparator) c = { ...c, columnSeparator: false };
    // 右半分は lead が 2 桁ぶん進めてあるので、ここでは進めない（二重に数えると以降の桁が全角 1 字ごとに 1 桁ずれる）
    if (c.kind === "dbcs-tail") continue;
    const w = c.kind === "dbcs-lead" ? 2 : 1;
    if (col + w - 1 > maxCols) break; // 全角が端末の右端をまたぐなら描かない
    const tint = rowTint || (view.rule && x.ruleAt !== undefined && view.ruleStyle !== "horizontal" && x.ruleAt.col === cellNo);
    const sg = sgrOf(c, mode, { ...(dim ? { dim } : {}), ...(tint ? { tint } : {}), ...(edge ? { edge } : {}) });
    if (sg !== last) {
      out += sg;
      last = sg;
    }
    const ch = glyphOf(c);
    out += isAscii(ch) ? ch : `\x1b[${col}G${ch}`;
    col += w;
  }
  return out + RESET + "\x1b[K";
}

/** 状態行。ACS のオペレーター情報域に当たる（入力禁止・メッセージ待ち・カーソル位置） */
function statusOf(snap: ScreenSnapshot, cursor: { row: number; col: number }, note: string | undefined, insert: boolean): string {
  const parts = [
    snap.keyboardLocked ? "入力禁止" : "入力可",
    snap.messageWaiting ? "メッセージ待ち" : "",
    snap.sysReqLine ? "SysReq" : "",
    insert ? "挿入" : "",
    `${String(cursor.row).padStart(2, "0")}/${String(cursor.col).padStart(3, "0")}`,
    snap.systemMessage ?? note ?? ""
  ].filter((s) => s !== "");
  return parts.join(" | ");
}

export function renderFrame(snap: ScreenSnapshot, opts: FrameOptions): Frame {
  const { cols, rows } = opts.viewport;
  const view = opts.view ?? PLAIN_VIEW;
  // ヘッダーは画面 + 状態行に加えて 1 行の余白があるときだけ出す（足りなければ画面を優先する）
  const top = view.header && rows >= snap.rows + 2 ? 1 : 0;
  const screenRows = Math.max(0, Math.min(snap.rows, rows - 1 - top));
  const out: string[] = [];
  if (top === 1) out.push(`\x1b[1;1H\x1b[0;30;46m${fitText(` ${headerText(view, opts.prefix ?? "]")}`, cols)}\x1b[K${RESET}`);
  const grid = view.grid ? gridOverlay(snap) : undefined;
  const sbcs = resolveSbcsView(view.kana, opts.hostKatakana === true);
  const texty = snap.cells.map(hasTextIn);
  const under = new Set<number>();
  if (grid) {
    for (const [k, g] of grid) {
      const r = Math.floor(k / 1000);
      if (view.hrule === "under" && g.hEdge === "top" && g.force !== true && g.mask !== undefined && (g.mask & 0b0101) === 0 && r > 1 && texty[r - 1] === true) {
        under.add((r - 1) * 1000 + (k % 1000));
      }
    }
  }
  for (let r = 0; r < screenRows; r++) {
    out.push(
      rowOf(snap.cells[r]!, {
        screenRow: r + 1,
        termRow: r + 1 + top,
        maxCols: cols,
        mode: opts.colorMode,
        ...(grid ? { grid } : {}),
        view,
        sbcs,
        hasText: texty[r] === true,
        under,
        ...(opts.ruleAt ? { ruleAt: opts.ruleAt } : {})
      })
    );
  }
  const cursor = opts.cursor ?? snap.cursor;
  if (rows >= 1) {
    const small = cols < snap.cols || rows < snap.rows + 1 ? `端末が小さい（${snap.cols}x${snap.rows + 1} が要る）` : undefined;
    const text = statusOf(snap, cursor, small ?? opts.note, opts.insert === true);
    out.push(`\x1b[${rows};1H\x1b[0;7m ${fitText(text, cols - 1)}\x1b[K${RESET}`);
  }
  const visible = cursor.row <= screenRows && cursor.col <= cols;
  return { rows: out, cursor: visible ? { row: cursor.row + top, col: cursor.col } : undefined };
}

/** 切り詰めは文字数で行う（全角は 2 桁数える） */
function fitText(text: string, width: number): string {
  let w = 0;
  let s = "";
  for (const ch of text) {
    const cw = ch.codePointAt(0)! > 0x2e7f ? 2 : 1;
    if (w + cw > width) break;
    s += ch;
    w += cw;
  }
  return s;
}

/**
 * 前のフレームとの差分だけを書く列を作る（行単位）。各行は CUP で始まるので、変わった行だけを出せばよい。
 * 同期出力（DECSET 2026）で囲む——非対応の端末は無視する。最後にカーソルを置く。
 */
export function paintDiff(prev: readonly string[] | undefined, next: Frame): string {
  let body = "";
  for (let i = 0; i < next.rows.length; i++) if (prev?.[i] !== next.rows[i]) body += next.rows[i];
  if (prev && prev.length > next.rows.length) {
    for (let i = next.rows.length; i < prev.length; i++) body += `\x1b[${i + 1};1H\x1b[2K`;
  }
  const cur = next.cursor ? `\x1b[${next.cursor.row};${next.cursor.col}H\x1b[?25h` : "\x1b[?25l";
  return `\x1b[?2026h${body}${cur}\x1b[?2026l`;
}
