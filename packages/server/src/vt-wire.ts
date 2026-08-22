import { isFullWidth } from "@ts5250/base";
import type { VtCell, VtColor, VtSnapshot, VtStyle } from "@ts5250/vt";

/**
 * **VT の画面をブラウザへ渡す形に畳む。**
 *
 * VT は 1 打鍵ごとにホストがエコーを返す。素直に全画面（24x80＝1,920 セル）を毎回流すと、
 * **入力しているだけで秒間何十回も全画面が飛ぶ**。ここで 3 つ削る（spec D3）。
 *
 * 1. **変わった行だけ**送る（`row` つきの疎な配列）
 * 2. **見た目は palette に括る**——1 メッセージで使う `VtStyle` を配列にし、run は添字で指す
 * 3. **同じ見た目の連なりをまとめる**（run-length）。行末の空白は落とす
 *
 * さらに **全角の継続セルは送らない**——等幅フォントなら全角そのものが 2 桁を占めるので、
 * 送ると 1 桁ぶん余計にずれる。
 */

/** 見た目。**既定値は省く**（大半のセルは既定なので、これだけで送る量が大きく減る） */
export interface WsVtStyle {
  fg?: VtColor;
  bg?: VtColor;
  bold?: true;
  dim?: true;
  italic?: true;
  underline?: true;
  blink?: true;
  reverse?: true;
  hidden?: true;
  strike?: true;
}

/** 同じ見た目が続く一区切り。`col` は 0 起点の桁 */
export interface WsVtRun {
  col: number;
  text: string;
  /** `styles` の添字。既定の見た目なら省略 */
  s?: number;
}

/** 変わった 1 行 */
export interface WsVtLine {
  row: number;
  runs: WsVtRun[];
}

export interface WsVtFrame {
  rows: number;
  cols: number;
  cursor: { row: number; col: number; visible: boolean };
  alternate: boolean;
  title: string;
  /** この通で使う見た目の一覧（run の `s` が指す） */
  styles: WsVtStyle[];
  /** 変わった行だけ。**空なら画面は変わっていない** */
  lines: WsVtLine[];
  /** 主画面から新しく流れ出た行（前回からの増分） */
  scrollback?: WsVtRun[][];
  /** スクロールバックの古い方が捨てられた本数（上限に達したとき） */
  scrollbackDropped?: number;
  /**
   * ホストが `ECHO` を握ったか＝文字モードが成立しているか。**変わったときだけ載る。**
   *
   * `vt-opened` の時点ではまだ交渉が終わっていないことがある——実ブラウザ検証で
   * 「エコーを返していません」の案内が出たまま残った。**画面に出す値は追随させる。**
   */
  hostEchoes?: boolean;
}

/**
 * **前回送った内容を覚えていて差分を作る。** 接続 1 本につき 1 つ持つ。
 *
 * 覚えるのは「行ごとの署名」だけ——セルを丸ごと持つと画面 2 枚ぶんのメモリを食う。
 */
export class VtFrameBuilder {
  private prevLines: string[] = [];
  private prevScrollback = 0;
  private prevTotal = 0;
  private prevMeta = "";

  /**
   * 差分を作る。**変化が無ければ `undefined`** を返す（送らない）。
   * `full` を立てると全行を出す（開いた直後・再購読のとき）。
   */
  build(snap: VtSnapshot, full = false): WsVtFrame | undefined {
    const styles: WsVtStyle[] = [];
    const index = new Map<string, number>();
    const styleIndex = (style: VtStyle): number | undefined => {
      const wire = toWireStyle(style);
      if (wire === undefined) return undefined;
      const key = JSON.stringify(wire);
      const hit = index.get(key);
      if (hit !== undefined) return hit;
      styles.push(wire);
      index.set(key, styles.length - 1);
      return styles.length - 1;
    };

    const lines: WsVtLine[] = [];
    const signatures: string[] = [];
    // **大きさが変わったら全行を出す**（前回の署名と行数が合わない）
    const resized = this.prevLines.length !== snap.rows;
    for (let row = 0; row < snap.cells.length; row++) {
      const cells = snap.cells[row] ?? [];
      const sig = signatureOf(cells);
      signatures.push(sig);
      if (!full && !resized && this.prevLines[row] === sig) continue;
      lines.push({ row, runs: runsOf(cells, styleIndex) });
    }

    // スクロールバックは**増えたぶんだけ**。
    //
    // ⚠ **長さでは判断できない。** 上限に達すると `scrollback.length` は変わらなくなるので、
    // 「増えていない」と誤って読む。**延べ本数（`scrollbackTotal`）**で見る。
    const now = snap.scrollback.length;
    const total = snap.scrollbackTotal;
    let scrollback: WsVtRun[][] | undefined;
    let dropped: number | undefined;
    if (full) {
      scrollback = snap.scrollback.map((l) => runsOf(l, styleIndex));
    } else if (total > this.prevTotal) {
      const added = Math.min(total - this.prevTotal, now);
      scrollback = snap.scrollback.slice(now - added).map((l) => runsOf(l, styleIndex));
      // 頭から落ちた本数 = 前回の本数 ＋ 増えた本数 − 今の本数
      const off = this.prevScrollback + added - now;
      if (off > 0) dropped = off;
    } else if (now < this.prevScrollback) {
      // `RIS` などで履歴ごと捨てられた
      dropped = this.prevScrollback - now;
      scrollback = [];
    }
    this.prevScrollback = now;
    this.prevTotal = total;
    this.prevLines = signatures;

    const meta = [
      snap.rows,
      snap.cols,
      snap.cursor.row,
      snap.cursor.col,
      String(snap.cursor.visible),
      String(snap.alternate),
      snap.title
    ].join("|");
    const metaChanged = meta !== this.prevMeta;
    this.prevMeta = meta;

    if (!full && lines.length === 0 && scrollback === undefined && !metaChanged) return undefined;

    return {
      rows: snap.rows,
      cols: snap.cols,
      cursor: snap.cursor,
      alternate: snap.alternate,
      title: snap.title,
      styles,
      lines,
      ...(scrollback !== undefined ? { scrollback } : {}),
      ...(dropped !== undefined ? { scrollbackDropped: dropped } : {})
    };
  }

  /** 再購読・リサイズのあとに全行を作り直させる */
  reset(): void {
    this.prevLines = [];
    this.prevScrollback = 0;
    this.prevTotal = 0;
    this.prevMeta = "";
  }
}

/** 行が変わったかを見るための署名。**見た目も含める**（文字はそのままで色だけ変わる場合がある） */
function signatureOf(cells: readonly VtCell[]): string {
  const parts: string[] = [];
  for (const c of cells) parts.push(c.char, styleKey(c.style));
  return parts.join("");
}

function styleKey(s: VtStyle): string {
  return [
    colorKey(s.fg),
    colorKey(s.bg),
    s.bold ? "b" : "",
    s.dim ? "d" : "",
    s.italic ? "i" : "",
    s.underline ? "u" : "",
    s.blink ? "k" : "",
    s.reverse ? "r" : "",
    s.hidden ? "h" : "",
    s.strike ? "s" : ""
  ].join("/");
}

function colorKey(c: VtColor): string {
  if (c.kind === "default") return "-";
  if (c.kind === "indexed") return `i${c.index}`;
  return `r${c.r},${c.g},${c.b}`;
}

/** 既定の見た目なら `undefined`（送らない） */
function toWireStyle(s: VtStyle): WsVtStyle | undefined {
  const out: WsVtStyle = {};
  let any = false;
  if (s.fg.kind !== "default") { out.fg = s.fg; any = true; }
  if (s.bg.kind !== "default") { out.bg = s.bg; any = true; }
  if (s.bold) { out.bold = true; any = true; }
  if (s.dim) { out.dim = true; any = true; }
  if (s.italic) { out.italic = true; any = true; }
  if (s.underline) { out.underline = true; any = true; }
  if (s.blink) { out.blink = true; any = true; }
  if (s.reverse) { out.reverse = true; any = true; }
  if (s.hidden) { out.hidden = true; any = true; }
  if (s.strike) { out.strike = true; any = true; }
  return any ? out : undefined;
}

/**
 * 1 行を run に畳む。
 *
 * - **継続セル（`width: 0`）は飛ばす**——全角そのものが 2 桁を占めるので、送るとずれる
 * - **行末の「既定の見た目の空白」は落とす**。1 行 80 桁のうち大半がこれ。
 *   ただし**見た目が付いた空白は残す**（背景色が塗られている）
 */
function runsOf(
  cells: readonly VtCell[],
  styleIndex: (s: VtStyle) => number | undefined
): WsVtRun[] {
  let end = cells.length;
  while (end > 0) {
    const c = cells[end - 1];
    if (c === undefined) break;
    if (c.char !== " " && c.char !== "") break;
    if (toWireStyle(c.style) !== undefined) break;
    end--;
  }

  const runs: WsVtRun[] = [];
  let cur: WsVtRun | undefined;
  let curKey = "";
  for (let col = 0; col < end; col++) {
    const cell = cells[col];
    if (cell === undefined) continue;
    if (cell.width === 0) continue; // 全角の右半分
    const key = styleKey(cell.style);
    if (cur !== undefined && key === curKey && cur.col + textCols(cur.text) === col) {
      cur.text += cell.char;
      continue;
    }
    const s = styleIndex(cell.style);
    cur = { col, text: cell.char, ...(s !== undefined ? { s } : {}) };
    curKey = key;
    runs.push(cur);
  }
  return runs;
}

/** run の文字列が占める桁数（全角は 2 桁）。**継続セルを飛ばしたぶんをここで勘定し直す** */
function textCols(text: string): number {
  let n = 0;
  for (const ch of text) n += isFullWidth(ch) ? 2 : 1;
  return n;
}
