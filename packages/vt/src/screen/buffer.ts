import { isFullWidth } from "@ts5250/base";
import { blankCell, DEFAULT_STYLE, type VtCell, type VtStyle } from "./types.js";

/**
 * **セル格子とカーソル。命令の意味は知らない**（それは `terminal.ts`）。
 *
 * ここが持つのは「書く・消す・寄せる・スクロールする」という**画面そのものの操作**だけ。
 * CSI の番号や既定値の解釈は一切入れない——入れると、規格の解釈違いを直すたびに
 * 画面の実装まで触ることになる。
 *
 * ## 遅延折返し（deferred wrap）
 *
 * DEC の端末は**右端に文字を書いた直後にはまだ折り返さない**。カーソルは右端に留まり、
 * *次の文字*が来て初めて行が変わる。これを再現しないと、右端ちょうどに書いてから
 * `CR`/`LF` が来る出力（`ls` の桁揃えで頻出）で**空行が 1 本余計に入る**。
 */
export class VtBuffer {
  /** 表示中の行（`rows` 本） */
  private lines: VtCell[][] = [];
  /** 主画面から流れ出た行。**代替画面のぶんは入れない**（spec D7） */
  private readonly scroll: VtCell[][] = [];
  /** 代替画面に移る前の主画面（`undefined` なら主画面を表示中） */
  private saved: { lines: VtCell[][]; cursorRow: number; cursorCol: number } | undefined;

  row = 0;
  col = 0;
  /** 遅延折返しの旗（右端に書いた直後） */
  private wrapPending = false;

  /** スクロール領域（0 起点・両端含む） */
  marginTop = 0;
  marginBottom: number;

  constructor(
    public rows: number,
    public cols: number,
    private readonly scrollbackLimit = 1000
  ) {
    this.marginBottom = rows - 1;
    this.lines = Array.from({ length: rows }, () => this.blankLine(DEFAULT_STYLE));
  }

  get alternate(): boolean {
    return this.saved !== undefined;
  }

  get scrollback(): readonly VtCell[][] {
    return this.scroll;
  }

  get displayLines(): readonly VtCell[][] {
    return this.lines;
  }

  private blankLine(style: VtStyle): VtCell[] {
    return Array.from({ length: this.cols }, () => blankCell(style));
  }

  // ---- 書く ----

  /**
   * カーソル位置に 1 文字置いて進める。
   *
   * `autoWrap` は `DECAWM`。無効なら右端で上書きし続ける（**行を越えない**）。
   */
  write(ch: string, style: VtStyle, autoWrap: boolean): void {
    const w = isFullWidth(ch) ? 2 : 1;

    if (this.wrapPending && autoWrap) {
      this.wrapPending = false;
      this.col = 0;
      this.lineFeed(style);
    }

    // **行末に 1 桁しか無い全角**: 折返しが効くなら次行へ送る。効かないなら書かずに捨てる
    if (w === 2 && this.col === this.cols - 1) {
      if (!autoWrap) return;
      this.setCell(this.row, this.col, blankCell(style));
      this.col = 0;
      this.lineFeed(style);
    }

    if (this.col >= this.cols) {
      if (!autoWrap) { this.col = this.cols - 1; }
      else { this.col = 0; this.lineFeed(style); }
    }

    if (w === 2) {
      this.clearHalf(this.row, this.col);
      this.clearHalf(this.row, this.col + 1);
      this.setCell(this.row, this.col, { char: ch, style, width: 2 });
      this.setCell(this.row, this.col + 1, { char: "", style, width: 0 });
      this.advance(2, autoWrap);
      return;
    }
    this.clearHalf(this.row, this.col);
    this.setCell(this.row, this.col, { char: ch, style, width: 1 });
    this.advance(1, autoWrap);
  }

  /** 結合文字・異体字セレクタは**直前のセルに足す**（新しい桁を消費しない） */
  combine(ch: string): boolean {
    const r = this.row;
    let c = this.col - 1;
    if (this.wrapPending) c = this.cols - 1;
    while (c >= 0 && this.lines[r]?.[c]?.width === 0) c--;
    if (c < 0) return false;
    const cell = this.lines[r]?.[c];
    if (cell === undefined || cell.char === "") return false;
    this.setCell(r, c, { ...cell, char: cell.char + ch });
    return true;
  }

  private advance(n: number, autoWrap: boolean): void {
    const next = this.col + n;
    if (next >= this.cols) {
      this.col = this.cols - 1;
      this.wrapPending = autoWrap;
      return;
    }
    this.col = next;
    this.wrapPending = false;
  }

  /**
   * 全角の**片割れを潰さない**。継続セルや全角の左を上書きするときは、対になるセルも空白に戻す。
   * これをしないと「半分だけ残った全角」が画面に居座る。
   */
  private clearHalf(row: number, col: number): void {
    const line = this.lines[row];
    if (line === undefined) return;
    const cell = line[col];
    if (cell === undefined) return;
    if (cell.width === 2 && col + 1 < this.cols) {
      line[col + 1] = blankCell(cell.style);
    } else if (cell.width === 0 && col - 1 >= 0) {
      const left = line[col - 1];
      if (left !== undefined) line[col - 1] = blankCell(left.style);
    }
  }

  private setCell(row: number, col: number, cell: VtCell): void {
    const line = this.lines[row];
    if (line === undefined || col < 0 || col >= this.cols) return;
    line[col] = cell;
  }

  // ---- カーソル ----

  moveTo(row: number, col: number): void {
    this.row = clamp(row, 0, this.rows - 1);
    this.col = clamp(col, 0, this.cols - 1);
    this.wrapPending = false;
    this.snapToWideLeft();
  }

  moveBy(dRow: number, dCol: number): void {
    this.moveTo(this.row + dRow, this.col + dCol);
  }

  /** カーソルが全角の右半分に乗ったら**左に寄せる**（spec D6） */
  private snapToWideLeft(): void {
    if (this.lines[this.row]?.[this.col]?.width === 0 && this.col > 0) this.col -= 1;
  }

  /** `LF` / `IND`: スクロール領域の下端なら 1 行送る */
  lineFeed(style: VtStyle): void {
    this.wrapPending = false;
    if (this.row === this.marginBottom) {
      this.scrollUp(1, style);
      return;
    }
    if (this.row < this.rows - 1) this.row += 1;
  }

  /** `RI`: 上端なら 1 行戻す */
  reverseIndex(style: VtStyle): void {
    this.wrapPending = false;
    if (this.row === this.marginTop) {
      this.scrollDown(1, style);
      return;
    }
    if (this.row > 0) this.row -= 1;
  }

  clearWrapPending(): void {
    this.wrapPending = false;
  }

  get pendingWrap(): boolean {
    return this.wrapPending;
  }

  // ---- スクロール ----

  /**
   * 領域内を上へ `n` 行。**主画面で領域が画面全体のときだけ**スクロールバックへ送る
   * （領域を切って使っているアプリの途中行を履歴に混ぜない）。
   */
  scrollUp(n: number, style: VtStyle): void {
    const full = this.marginTop === 0 && this.marginBottom === this.rows - 1;
    for (let i = 0; i < n; i++) {
      const gone = this.lines[this.marginTop];
      this.lines.splice(this.marginTop, 1);
      this.lines.splice(this.marginBottom, 0, this.blankLine(style));
      if (gone !== undefined && full && !this.alternate) this.pushScrollback(gone);
    }
  }

  scrollDown(n: number, style: VtStyle): void {
    for (let i = 0; i < n; i++) {
      this.lines.splice(this.marginBottom, 1);
      this.lines.splice(this.marginTop, 0, this.blankLine(style));
    }
  }

  private pushScrollback(line: VtCell[]): void {
    if (this.scrollbackLimit <= 0) return;
    this.scroll.push(line);
    if (this.scroll.length > this.scrollbackLimit) this.scroll.shift();
  }

  setMargins(top: number, bottom: number): void {
    if (top >= bottom) return;
    this.marginTop = clamp(top, 0, this.rows - 1);
    this.marginBottom = clamp(bottom, 0, this.rows - 1);
  }

  resetMargins(): void {
    this.marginTop = 0;
    this.marginBottom = this.rows - 1;
  }

  // ---- 消す ----

  /** `EL`: 0=カーソルから右 / 1=左からカーソルまで / 2=行全体 */
  eraseInLine(mode: 0 | 1 | 2, style: VtStyle): void {
    const line = this.lines[this.row];
    if (line === undefined) return;
    const from = mode === 0 ? this.col : 0;
    const to = mode === 1 ? this.col : this.cols - 1;
    this.clearHalf(this.row, from);
    this.clearHalf(this.row, to);
    for (let c = from; c <= to; c++) line[c] = blankCell(style);
    this.wrapPending = false;
  }

  /** `ED`: 0=カーソルから下 / 1=上からカーソルまで / 2=画面全体 / 3=スクロールバックも */
  eraseInDisplay(mode: 0 | 1 | 2 | 3, style: VtStyle): void {
    if (mode === 3) {
      this.scroll.length = 0;
      return;
    }
    if (mode === 2) {
      this.lines = Array.from({ length: this.rows }, () => this.blankLine(style));
      this.wrapPending = false;
      return;
    }
    if (mode === 0) {
      this.eraseInLine(0, style);
      for (let r = this.row + 1; r < this.rows; r++) this.lines[r] = this.blankLine(style);
      return;
    }
    this.eraseInLine(1, style);
    for (let r = 0; r < this.row; r++) this.lines[r] = this.blankLine(style);
  }

  /** `ECH`: カーソル位置から `n` 桁を空白に（**桁は詰めない**） */
  eraseChars(n: number, style: VtStyle): void {
    const line = this.lines[this.row];
    if (line === undefined) return;
    const end = Math.min(this.cols, this.col + n);
    this.clearHalf(this.row, this.col);
    this.clearHalf(this.row, end - 1);
    for (let c = this.col; c < end; c++) line[c] = blankCell(style);
  }

  // ---- 挿入・削除 ----

  insertChars(n: number, style: VtStyle): void {
    const line = this.lines[this.row];
    if (line === undefined) return;
    this.clearHalf(this.row, this.col);
    line.splice(this.col, 0, ...Array.from({ length: n }, () => blankCell(style)));
    line.length = this.cols;
  }

  deleteChars(n: number, style: VtStyle): void {
    const line = this.lines[this.row];
    if (line === undefined) return;
    this.clearHalf(this.row, this.col);
    line.splice(this.col, n);
    while (line.length < this.cols) line.push(blankCell(style));
  }

  /** `IL`: **スクロール領域の中でだけ**行を押し下げる */
  insertLines(n: number, style: VtStyle): void {
    if (this.row < this.marginTop || this.row > this.marginBottom) return;
    for (let i = 0; i < n; i++) {
      this.lines.splice(this.marginBottom, 1);
      this.lines.splice(this.row, 0, this.blankLine(style));
    }
    this.col = 0;
  }

  deleteLines(n: number, style: VtStyle): void {
    if (this.row < this.marginTop || this.row > this.marginBottom) return;
    for (let i = 0; i < n; i++) {
      this.lines.splice(this.row, 1);
      this.lines.splice(this.marginBottom, 0, this.blankLine(style));
    }
    this.col = 0;
  }

  // ---- 代替画面（spec D7）----

  /**
   * 代替画面へ。**主画面とスクロールバックはそのまま取っておく**ので、
   * `vi` を抜けたら元の画面が丸ごと戻る。
   */
  enterAlternate(style: VtStyle): void {
    if (this.alternate) return;
    this.saved = { lines: this.lines, cursorRow: this.row, cursorCol: this.col };
    this.lines = Array.from({ length: this.rows }, () => this.blankLine(style));
    this.wrapPending = false;
  }

  leaveAlternate(): void {
    const saved = this.saved;
    if (saved === undefined) return;
    this.lines = saved.lines;
    this.row = clamp(saved.cursorRow, 0, this.rows - 1);
    this.col = clamp(saved.cursorCol, 0, this.cols - 1);
    this.saved = undefined;
    this.wrapPending = false;
  }

  // ---- 大きさ ----

  /**
   * 画面の大きさを変える。
   *
   * **行の再折返しはしない**（spec の未決事項）。桁が減れば右を切り、増えれば空白で足す。
   * xterm は再折返しするが実装差が大きく、**折り返し直した結果が元と違う**方が
   * 利用者を驚かせる。まずは「切る」で始め、要望が出たら測ってから変える。
   */
  resize(rows: number, cols: number, style: VtStyle): void {
    const fit = (line: VtCell[]): VtCell[] => {
      const out = line.slice(0, cols);
      while (out.length < cols) out.push(blankCell(style));
      // 切った縁に全角の左半分だけが残ったら空白に戻す
      const last = out[cols - 1];
      if (last !== undefined && last.width === 2) out[cols - 1] = blankCell(last.style);
      return out;
    };
    this.cols = cols;
    this.lines = this.lines.map(fit);
    for (let i = 0; i < this.scroll.length; i++) {
      const line = this.scroll[i];
      if (line !== undefined) this.scroll[i] = fit(line);
    }
    if (this.saved !== undefined) {
      // **退避してある主画面も同じ行数に揃える。** 揃えないと `vi` を代替画面で開いたまま
      // 窓を変えたとき、抜けた瞬間に行数の合わない画面が戻る
      const saved = this.saved.lines.map(fit);
      this.saved.cursorRow = shrinkTo(saved, rows, this.saved.cursorRow);
      while (saved.length < rows) saved.push(this.blankLine(style));
      this.saved.lines = saved;
      this.saved.cursorCol = clamp(this.saved.cursorCol, 0, cols - 1);
    }

    // **カーソルより下から先に捨てる。** 上から捨てると、画面の上の方にしか書いていない
    // 状態（シェルを開いた直後など）で**書いた内容だけが消えて空行が残る**
    this.row = shrinkTo(this.lines, rows, this.row, (gone) => {
      if (!this.alternate) this.pushScrollback(gone);
    });
    while (this.lines.length < rows) this.lines.push(this.blankLine(style));
    this.rows = rows;
    this.resetMargins();
    this.row = clamp(this.row, 0, rows - 1);
    this.col = clamp(this.col, 0, cols - 1);
    this.wrapPending = false;
  }

  /** `RIS` / 全消去。スクロールバックも捨てる */
  hardReset(style: VtStyle): void {
    this.saved = undefined;
    this.scroll.length = 0;
    this.lines = Array.from({ length: this.rows }, () => this.blankLine(style));
    this.row = 0;
    this.col = 0;
    this.wrapPending = false;
    this.resetMargins();
  }
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/**
 * 行数を `rows` まで減らす。**カーソルより下を先に捨て**、足りなければ上から捨てる。
 *
 * 上からだけ捨てると、画面の上にしか書いていない状態で**書いた内容が消えて空行が残る**。
 * 下からだけ捨てると、画面いっぱいのときに入力中の行が消える。両方を見る必要がある。
 *
 * 戻り値は新しいカーソル行。
 */
function shrinkTo<T>(
  lines: T[],
  rows: number,
  cursorRow: number,
  onDropTop?: (line: T) => void
): number {
  let row = cursorRow;
  while (lines.length > rows) {
    if (lines.length - 1 > row) {
      lines.pop();
      continue;
    }
    const gone = lines.shift();
    if (gone !== undefined) onDropTop?.(gone);
    if (row > 0) row -= 1;
  }
  return clamp(row, 0, Math.max(0, rows - 1));
}
