import { childLog } from "@ts5250/base";
import type { VtEvent, VtParam } from "../protocol/parser.js";
import { VtBuffer } from "./buffer.js";
import { charsetFor, mapChar, type CharsetId } from "./charset.js";
import { defaultModes, type VtModes } from "./modes.js";
import { applySgr } from "./sgr.js";
import { DEFAULT_STYLE, eraseStyleOf, type VtSnapshot, type VtStyle } from "./types.js";

const log = childLog({ component: "vt-terminal" });

/**
 * **パーサが割った命令を画面に効かせる層。**
 *
 * ここが「規格の解釈」を全部背負う——既定値・原点モード・スクロール領域・文字集合。
 * 画面そのものの操作は `VtBuffer`、`SGR` の畳み込みは `sgr.ts` に分けてあるので、
 * この層は**分岐だけ**で読める。
 *
 * ## ホストへ返す
 *
 * `DA` / `DSR` / `CPR` は**返さないとホストが待つ**（research 2.1 で `ESC[c` が実際に飛んできた）。
 * ただしここはソケットを知らないので、**返すべきバイト列を `replies` に積んで返す**だけにする。
 * 送るのはセッション層の仕事。
 */
export class VtTerminal {
  readonly buffer: VtBuffer;
  readonly modes: VtModes = defaultModes();
  style: VtStyle = DEFAULT_STYLE;
  title = "";

  /**
   * 消去・スクロール・挿入削除で**新しく現れる桁**を塗る見た目（BCE。`eraseStyleOf` の項）。
   *
   * `this.style` をそのまま渡してはいけない——下線や反転まで引き継ぐと、書いていない桁に
   * 罫が走ったり画面が反転の地色で埋まったりする。**書く（`print`）だけが `this.style`**。
   */
  private get eraseStyle(): VtStyle {
    return eraseStyleOf(this.style);
  }

  /** タブ位置（既定 8 桁ごと） */
  private tabs = new Set<number>();
  /** G0/G1 の文字集合と、いま呼び出している方（`SI`/`SO`） */
  private charsets: [CharsetId, CharsetId] = ["ascii", "ascii"];
  private gl: 0 | 1 = 0;
  /** `DECSC` の退避（カーソル・見た目・文字集合・原点モードをひとまとめに） */
  private savedCursor:
    | { row: number; col: number; style: VtStyle; charsets: [CharsetId, CharsetId]; gl: 0 | 1; origin: boolean }
    | undefined;

  /** タイトルが変わったら呼ばれる（利用側がタブ名に使う） */
  onTitle: ((title: string) => void) | undefined;
  /** ベル（`BEL`） */
  onBell: (() => void) | undefined;

  constructor(rows = 24, cols = 80, scrollbackLimit = 1000) {
    this.buffer = new VtBuffer(rows, cols, scrollbackLimit);
    this.resetTabs();
  }

  /** 命令を効かせ、**ホストへ返すべきバイト列**があれば返す */
  handle(events: readonly VtEvent[]): Uint8Array[] {
    const replies: Uint8Array[] = [];
    for (const e of events) {
      switch (e.kind) {
        case "print": this.print(e.text); break;
        case "execute": this.execute(e.code); break;
        case "esc": this.esc(e.intermediates, e.final); break;
        case "csi": this.csi(e.prefix, e.params, e.intermediates, e.final, replies); break;
        case "osc": this.osc(e.command, e.data); break;
        case "dcs":
          // 今は中身を使わない。**来たことだけ残す**（Sixel 等が来ていれば診断で分かる）
          log.debug(`DCS ${e.intermediates}${e.final} (${e.data.length} 文字) を読み飛ばした`);
          break;
      }
    }
    return replies;
  }

  snapshot(): VtSnapshot {
    return {
      rows: this.buffer.rows,
      cols: this.buffer.cols,
      cursor: {
        row: this.buffer.row,
        col: this.buffer.col,
        visible: this.modes.cursorVisible
      },
      cells: this.buffer.displayLines.map((l) => l.slice()),
      scrollback: this.buffer.scrollback.map((l) => l.slice()),
      scrollbackTotal: this.buffer.scrollbackTotal,
      alternate: this.buffer.alternate,
      title: this.title
    };
  }

  resize(rows: number, cols: number): void {
    this.buffer.resize(rows, cols, this.eraseStyle);
    this.resetTabs();
  }

  // ---- 印字 ----

  private print(text: string): void {
    const cs = this.charsets[this.gl];
    for (const ch of text) {
      // 結合文字・異体字セレクタは桁を消費せず直前のセルに足す
      if (isCombining(ch) && this.buffer.combine(ch)) continue;
      const mapped = mapChar(ch, cs);
      if (this.modes.insert) this.buffer.insertChars(1, this.eraseStyle);
      this.buffer.write(mapped, this.style, this.modes.autoWrap);
    }
  }

  // ---- C0 ----

  private execute(code: number): void {
    switch (code) {
      case 0x07: this.onBell?.(); return;
      case 0x08: // BS
        if (this.buffer.pendingWrap) { this.buffer.clearWrapPending(); return; }
        this.buffer.moveBy(0, -1);
        return;
      case 0x09: this.tabForward(1); return;
      case 0x0a: case 0x0b: case 0x0c: // LF / VT / FF
        this.buffer.lineFeed(this.eraseStyle);
        if (this.modes.newLine) this.buffer.moveTo(this.buffer.row, 0);
        return;
      case 0x0d: this.buffer.moveTo(this.buffer.row, 0); return;
      case 0x0e: this.gl = 1; return; // SO
      case 0x0f: this.gl = 0; return; // SI
      default: return;
    }
  }

  // ---- ESC ----

  private esc(intermediates: string, final: string): void {
    if (intermediates === "(") { this.charsets[0] = charsetFor(final); return; }
    if (intermediates === ")") { this.charsets[1] = charsetFor(final); return; }
    if (intermediates === "#") {
      // DECALN: 画面を 'E' で埋める（位置合わせ試験）
      if (final === "8") this.fillScreen("E");
      return;
    }
    switch (final) {
      case "7": this.saveCursor(); return;
      case "8": this.restoreCursor(); return;
      case "D": this.buffer.lineFeed(this.eraseStyle); return;         // IND
      case "M": this.buffer.reverseIndex(this.eraseStyle); return;     // RI
      case "E": this.buffer.moveTo(this.buffer.row, 0); this.buffer.lineFeed(this.eraseStyle); return; // NEL
      case "H": this.tabs.add(this.buffer.col); return;                // HTS
      case "=": this.modes.applicationKeypad = true; return;           // DECKPAM
      case ">": this.modes.applicationKeypad = false; return;          // DECKPNM
      case "c": this.hardReset(); return;                              // RIS
      default: return;
    }
  }

  // ---- CSI ----

  private csi(
    prefix: string,
    params: readonly VtParam[],
    intermediates: string,
    final: string,
    replies: Uint8Array[]
  ): void {
    // **0 と省略はどちらも「既定」**（`ESC[0A` は 1 行上。規格どおり）
    const n = (i = 0, dflt = 1): number => {
      const v = params[i];
      return typeof v === "number" && v > 0 ? v : dflt;
    };
    const raw = (i = 0): number | undefined => {
      const v = params[i];
      return typeof v === "number" ? v : undefined;
    };

    if (prefix === "?") {
      if (final === "h") { this.setDecModes(params, true); return; }
      if (final === "l") { this.setDecModes(params, false); return; }
      if (final === "n") { this.deviceStatus(raw(0), replies, true); return; }
      return;
    }
    if (prefix === ">") {
      // DA2: xterm を名乗る。`>4;Nm`（modifyOtherKeys）等は読み飛ばして構わない
      if (final === "c") replies.push(ascii("\x1b[>41;0;0c"));
      return;
    }
    if (intermediates === "!" && final === "p") { this.softReset(); return; }
    if (intermediates === "$" || intermediates === "\"" || intermediates === " ") return;

    const b = this.buffer;
    // **消去系は `this.style` ではなく `this.eraseStyle`**（BCE）。`eraseStyleOf` の項を見よ
    const es = this.eraseStyle;
    switch (final) {
      case "@": b.insertChars(n(), es); return;                              // ICH
      case "A": b.moveBy(-n(), 0); return;                                   // CUU
      case "B": case "e": b.moveBy(n(), 0); return;                          // CUD / VPR
      case "C": case "a": b.moveBy(0, n()); return;                          // CUF / HPR
      case "D": b.moveBy(0, -n()); return;                                   // CUB
      case "E": b.moveTo(b.row + n(), 0); return;                            // CNL
      case "F": b.moveTo(b.row - n(), 0); return;                            // CPL
      case "G": case "`": b.moveTo(b.row, n() - 1); return;                  // CHA / HPA
      case "H": case "f": this.cup(raw(0) ?? 1, raw(1) ?? 1); return;        // CUP / HVP
      case "I": this.tabForward(n()); return;                                // CHT
      case "J": b.eraseInDisplay(clampMode(raw(0) ?? 0, 3), es); return;         // ED
      case "K": b.eraseInLine(clampMode(raw(0) ?? 0, 2) as 0 | 1 | 2, es); return; // EL
      case "L": b.insertLines(n(), es); return;                              // IL
      case "M": b.deleteLines(n(), es); return;                              // DL
      case "P": b.deleteChars(n(), es); return;                              // DCH
      case "S": b.scrollUp(n(), es); return;                                 // SU
      case "T": b.scrollDown(n(), es); return;                               // SD
      case "X": b.eraseChars(n(), es); return;                               // ECH
      case "Z": this.tabBack(n()); return;                                   // CBT
      case "c": replies.push(ascii(DA1)); return;                            // DA1
      case "d": b.moveTo(n() - 1, b.col); return;                            // VPA
      case "g": this.tabClear(raw(0) ?? 0); return;                          // TBC
      case "h": this.setAnsiModes(params, true); return;                     // SM
      case "l": this.setAnsiModes(params, false); return;                    // RM
      case "m": this.style = applySgr(this.style, params); return;           // SGR
      case "n": this.deviceStatus(raw(0), replies, false); return;           // DSR
      case "r": this.setScrollRegion(raw(0), raw(1)); return;                // DECSTBM
      case "s": this.saveCursor(); return;
      case "u": this.restoreCursor(); return;
      case "t": return;                                                      // XTWINOPS: 無視
      default: return;
    }
  }

  /** `CUP` は**原点モードでスクロール領域の上端が 1 行目になる** */
  private cup(row: number, col: number): void {
    const top = this.modes.origin ? this.buffer.marginTop : 0;
    const bottom = this.modes.origin ? this.buffer.marginBottom : this.buffer.rows - 1;
    const target = top + row - 1;
    this.buffer.moveTo(Math.min(target, bottom), col - 1);
  }

  private setScrollRegion(top: number | undefined, bottom: number | undefined): void {
    const t = (top ?? 1) - 1;
    const bo = (bottom ?? this.buffer.rows) - 1;
    if (t >= bo) { this.buffer.resetMargins(); }
    else { this.buffer.setMargins(t, bo); }
    // **DECSTBM はカーソルを原点へ戻す**（規格。戻さないと `less` の初回描画が 1 行ずれる）
    this.cup(1, 1);
  }

  // ---- モード ----

  private setDecModes(params: readonly VtParam[], on: boolean): void {
    for (const p of params) {
      if (typeof p !== "number") continue;
      switch (p) {
        case 1: this.modes.applicationCursorKeys = on; break;
        case 3:
          // DECCOLM: **桁を変える権限は利用側にある**（勝手に画面を作り替えない）。
          // 要求されたことだけ覚えて、規格どおり画面を消してカーソルを戻す
          this.modes.columns132 = on;
          this.buffer.eraseInDisplay(2, this.eraseStyle);
          this.buffer.moveTo(0, 0);
          break;
        case 5: this.modes.reverseVideo = on; break;
        case 6:
          this.modes.origin = on;
          this.cup(1, 1);
          break;
        case 7: this.modes.autoWrap = on; break;
        case 12: break; // カーソル点滅。描画側の好みなので保持しない
        case 25: this.modes.cursorVisible = on; break;
        case 47: case 1047:
          if (on) this.buffer.enterAlternate(this.eraseStyle);
          else this.buffer.leaveAlternate();
          break;
        case 1048:
          if (on) this.saveCursor(); else this.restoreCursor();
          break;
        case 1049:
          // **`1049` は「カーソル退避 ＋ 代替画面 ＋ 消去」**。`vi` も `less` もこれしか使わない
          if (on) { this.saveCursor(); this.buffer.enterAlternate(this.eraseStyle); }
          else { this.buffer.leaveAlternate(); this.restoreCursor(); }
          break;
        case 1000: this.modes.mouse = on ? "click" : "off"; break;
        case 1002: this.modes.mouse = on ? "drag" : "off"; break;
        case 1003: this.modes.mouse = on ? "any" : "off"; break;
        case 1005: break; // UTF-8 マウス: 使わない（1006 を優先する）
        case 1006: this.modes.mouseEncoding = on ? "sgr" : "x10"; break;
        case 2004: this.modes.bracketedPaste = on; break;
        default: break;
      }
    }
  }

  private setAnsiModes(params: readonly VtParam[], on: boolean): void {
    for (const p of params) {
      if (p === 4) this.modes.insert = on;
      else if (p === 20) this.modes.newLine = on;
    }
  }

  // ---- 応答（spec D10）----

  private deviceStatus(code: number | undefined, replies: Uint8Array[], dec: boolean): void {
    if (code === 5) { replies.push(ascii("\x1b[0n")); return; }
    if (code === 6) {
      const top = this.modes.origin ? this.buffer.marginTop : 0;
      const row = this.buffer.row - top + 1;
      const col = this.buffer.col + 1;
      replies.push(ascii(dec ? `\x1b[?${row};${col}R` : `\x1b[${row};${col}R`));
    }
  }

  // ---- タブ ----

  private resetTabs(): void {
    this.tabs = new Set<number>();
    for (let c = 8; c < this.buffer.cols; c += 8) this.tabs.add(c);
  }

  private tabForward(n: number): void {
    let col = this.buffer.col;
    for (let i = 0; i < n; i++) {
      let next = this.buffer.cols - 1;
      for (let c = col + 1; c < this.buffer.cols; c++) {
        if (this.tabs.has(c)) { next = c; break; }
      }
      col = next;
    }
    this.buffer.moveTo(this.buffer.row, col);
  }

  private tabBack(n: number): void {
    let col = this.buffer.col;
    for (let i = 0; i < n; i++) {
      let prev = 0;
      for (let c = col - 1; c >= 0; c--) {
        if (this.tabs.has(c)) { prev = c; break; }
      }
      col = prev;
    }
    this.buffer.moveTo(this.buffer.row, col);
  }

  private tabClear(mode: number): void {
    if (mode === 3) this.tabs.clear();
    else if (mode === 0) this.tabs.delete(this.buffer.col);
  }

  // ---- カーソルの退避 ----

  private saveCursor(): void {
    this.savedCursor = {
      row: this.buffer.row,
      col: this.buffer.col,
      style: this.style,
      charsets: [this.charsets[0], this.charsets[1]],
      gl: this.gl,
      origin: this.modes.origin
    };
  }

  private restoreCursor(): void {
    const s = this.savedCursor;
    if (s === undefined) { this.buffer.moveTo(0, 0); return; }
    this.style = s.style;
    this.charsets = [s.charsets[0], s.charsets[1]];
    this.gl = s.gl;
    this.modes.origin = s.origin;
    this.buffer.moveTo(s.row, s.col);
  }

  // ---- リセット ----

  /** `DECSTR`（ソフト）: 画面は消さず、モードと見た目を既定へ */
  private softReset(): void {
    Object.assign(this.modes, defaultModes());
    this.style = DEFAULT_STYLE;
    this.charsets = ["ascii", "ascii"];
    this.gl = 0;
    this.savedCursor = undefined;
    this.buffer.resetMargins();
  }

  /** `RIS`（ハード）: 画面もスクロールバックも捨てる */
  private hardReset(): void {
    this.softReset();
    this.title = "";
    this.buffer.hardReset(DEFAULT_STYLE);
    this.resetTabs();
  }

  private fillScreen(ch: string): void {
    for (let r = 0; r < this.buffer.rows; r++) {
      this.buffer.moveTo(r, 0);
      for (let c = 0; c < this.buffer.cols; c++) this.buffer.write(ch, this.style, false);
    }
    this.buffer.moveTo(0, 0);
  }

  // ---- OSC ----

  private osc(command: number, data: string): void {
    // 0=アイコン＋タイトル / 1=アイコン / 2=タイトル。**それ以外は読み飛ばす**
    if (command === 0 || command === 2) {
      this.title = data;
      this.onTitle?.(data);
    }
  }
}

/** VT420 相当＋色を名乗る（spec D10） */
const DA1 = "\x1b[?64;1;2;6;22c";

const ascii = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);

const clampMode = (v: number, max: number): 0 | 1 | 2 | 3 =>
  (v < 0 || v > max ? 0 : v) as 0 | 1 | 2 | 3;

/** 結合文字・異体字セレクタ（桁を消費しない） */
function isCombining(ch: string): boolean {
  const cp = ch.codePointAt(0) ?? 0;
  return (
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    (cp >= 0xfe20 && cp <= 0xfe2f)
  );
}
