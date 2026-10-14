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

export type ColorMode = "truecolor" | "256";

export interface FrameOptions {
  /** 端末の大きさ（桁・行）。5250 の画面 + 状態行の 1 行より小さければ左上を合わせて切る */
  viewport: { cols: number; rows: number };
  colorMode: ColorMode;
  /** 状態行に出す一言（操作の結果・エラーなど） */
  note?: string;
  /** カーソルの位置（1 始まり）。省略時はホストの指定 */
  cursor?: { row: number; col: number };
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
export function sgrOf(c: Cell, mode: ColorMode): string {
  const p = ["0", (mode === "truecolor" ? TRUE : C256)[c.color]];
  if (c.reverse) p.push("7");
  // 下線は DDS の指定（underline）。桁区切りだけのときは点線の下線（4:4）。両方なら実線を優先する
  if (c.underline) p.push("4");
  else if (c.columnSeparator) p.push("4:4");
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
function rowOf(cells: readonly Cell[], termRow: number, maxCols: number, mode: ColorMode): string {
  let out = `\x1b[${termRow};1H`;
  let last = "";
  let col = 1;
  for (const c of cells) {
    // 右半分は lead が 2 桁ぶん進めてあるので、ここでは進めない（二重に数えると以降の桁が全角 1 字ごとに 1 桁ずれる）
    if (c.kind === "dbcs-tail") continue;
    const w = c.kind === "dbcs-lead" ? 2 : 1;
    if (col + w - 1 > maxCols) break; // 全角が端末の右端をまたぐなら描かない
    const sg = sgrOf(c, mode);
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
function statusOf(snap: ScreenSnapshot, cursor: { row: number; col: number }, note: string | undefined): string {
  const parts = [
    snap.keyboardLocked ? "入力禁止" : "入力可",
    snap.messageWaiting ? "メッセージ待ち" : "",
    snap.sysReqLine ? "SysReq" : "",
    `${String(cursor.row).padStart(2, "0")}/${String(cursor.col).padStart(3, "0")}`,
    snap.systemMessage ?? note ?? ""
  ].filter((s) => s !== "");
  return parts.join(" | ");
}

export function renderFrame(snap: ScreenSnapshot, opts: FrameOptions): Frame {
  const { cols, rows } = opts.viewport;
  const screenRows = Math.max(0, Math.min(snap.rows, rows - 1));
  const out: string[] = [];
  for (let r = 0; r < screenRows; r++) out.push(rowOf(snap.cells[r]!, r + 1, cols, opts.colorMode));
  const cursor = opts.cursor ?? snap.cursor;
  if (rows >= 1) {
    const small = cols < snap.cols || rows < snap.rows + 1 ? `端末が小さい（${snap.cols}x${snap.rows + 1} が要る）` : undefined;
    const text = statusOf(snap, cursor, small ?? opts.note);
    // 状態行は端末の最終行。切り詰めは文字数で行う（全角は 2 桁数える）
    let w = 0;
    let s = "";
    for (const ch of text) {
      const cw = ch.codePointAt(0)! > 0x2e7f ? 2 : 1;
      if (w + cw > cols - 1) break;
      s += ch;
      w += cw;
    }
    out.push(`\x1b[${rows};1H\x1b[0;7m ${s}\x1b[K${RESET}`);
  }
  const visible = cursor.row <= screenRows && cursor.col <= cols;
  return { rows: out, cursor: visible ? { row: cursor.row, col: cursor.col } : undefined };
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
