import { VtDecoder, type VtEncoding } from "../text/codec.js";

/**
 * **DEC ANSI エスケープ列の状態機械。**
 *
 * 構成は Paul Williams が VT500 系の実装から起こした状態図
 * （`ground` / `escape` / `csi_*` / `osc_string` / `dcs_*` / `sos_pm_apc_string`）に従う。
 * **画面のことは何も知らない**——バイト列を「命令」に割るだけ。実行は `screen/terminal.ts`。
 *
 * ## 守っていること
 *
 * - **バイト単位で回し、状態はインスタンスに持つ。** `feed()` は何度呼ばれてもよく、
 *   エスケープ列が TCP のセグメント境界で割れても壊れない（実測で必ず割れる）
 * - **不正な列は捨てて次へ進む**（`csi_ignore`）。例外を投げて端末を止めない
 * - **8 ビット C1（0x80-0x9F）は既定で採らない。** UTF-8 の後続バイトとも
 *   Shift_JIS の先頭バイトとも衝突するため、`eightBitControls` で明示的に開けたときだけ扱う
 * - **印字はまとめて出す。** 1 文字ずつイベントにすると、1 画面ぶんで数千回になる
 */

/** CSI のパラメータ。`38:2::r:g:b` のようにコロンで割れた組は配列になる */
export type VtParam = number | undefined | readonly (number | undefined)[];

export type VtEvent =
  /** 画面に出す文字（復号済み。複数文字がまとまって来る） */
  | { kind: "print"; text: string }
  /** C0 制御（`0x00`-`0x1F` と `0x7F`）。`\r` `\n` `\b` `\t` など */
  | { kind: "execute"; code: number }
  /** `ESC` ＋ 中間バイト ＋ 終端（`ESC 7` / `ESC ( B` / `ESC =` …） */
  | { kind: "esc"; intermediates: string; final: string }
  /** `CSI` ＋ プレフィクス（`?` `>` `<` `=`）＋ パラメータ ＋ 中間 ＋ 終端 */
  | { kind: "csi"; prefix: string; params: readonly VtParam[]; intermediates: string; final: string }
  /** `OSC <番号> ; <本文> ST`（タイトル設定など） */
  | { kind: "osc"; command: number; data: string }
  /** `DCS`（本文つき）。今は中身を使わないが、**読み飛ばした事実**は上に伝える */
  | { kind: "dcs"; params: readonly VtParam[]; intermediates: string; final: string; data: string };

export interface VtParserOptions {
  /** 受信の符号化（既定 `utf-8`） */
  encoding?: VtEncoding;
  /**
   * 8 ビット C1（0x80-0x9F）を制御として扱うか。**既定 false。**
   * UTF-8 / Shift_JIS の多バイト文字と衝突するので、8 ビット端末と分かっているときだけ true。
   */
  eightBitControls?: boolean;
  /** OSC / DCS の本文の上限（暴走したホストでメモリを食い潰さない）。既定 8,192 */
  maxStringLength?: number;
}

type State =
  | "ground"
  | "escape"
  | "escape_intermediate"
  | "csi_entry"
  | "csi_param"
  | "csi_intermediate"
  | "csi_ignore"
  | "osc_string"
  | "dcs_entry"
  | "dcs_param"
  | "dcs_intermediate"
  | "dcs_passthrough"
  | "dcs_ignore"
  | "sos_pm_apc_string";

const DEFAULT_MAX_STRING = 8192;

export class VtParser {
  private state: State = "ground";
  private readonly decoder: VtDecoder;
  private readonly eightBit: boolean;
  private readonly maxString: number;

  /** 印字待ちのバイト（**復号は出すときにまとめて**行う。分割到着に強い） */
  private printBuf: number[] = [];

  private params = "";
  private intermediates = "";
  private prefix = "";
  private stringBuf = "";
  private stringOverflow = false;
  private dcsFinal = "";
  private pendingEscInString = false;

  constructor(opts: VtParserOptions = {}) {
    this.decoder = new VtDecoder(opts.encoding ?? "utf-8");
    this.eightBit = opts.eightBitControls ?? false;
    this.maxString = opts.maxStringLength ?? DEFAULT_MAX_STRING;
  }

  /**
   * バイト列を食わせ、切り出せた命令を返す。
   * **返ってこなかったぶんは内部に残る**（次の `feed` で続きが来る前提）。
   */
  feed(bytes: Uint8Array): VtEvent[] {
    const out: VtEvent[] = [];
    for (const b of bytes) this.step(b, out);
    this.flushPrint(out);
    return out;
  }

  /** 接続を閉じるときに、持ち越した文字を吐き出す */
  end(): VtEvent[] {
    const out: VtEvent[] = [];
    this.flushPrint(out);
    const tail = this.decoder.flush();
    if (tail !== "") out.push({ kind: "print", text: tail });
    return out;
  }

  // ---- 内部 ----

  private flushPrint(out: VtEvent[]): void {
    if (this.printBuf.length === 0) return;
    const text = this.decoder.decode(Uint8Array.from(this.printBuf));
    this.printBuf = [];
    if (text !== "") out.push({ kind: "print", text });
  }

  /** C0 / 8 ビット C1 は**どの状態からでも割り込む**（状態図の「anywhere」） */
  private anywhere(b: number, out: VtEvent[]): boolean {
    if (b === 0x18 || b === 0x1a) {
      // CAN / SUB: 進行中の列を捨てて ground へ
      this.flushPrint(out);
      this.reset();
      return true;
    }
    if (b === 0x1b) {
      this.flushPrint(out);
      this.enterEscape();
      return true;
    }
    if (!this.eightBit) return false;
    if (b === 0x9b) { this.flushPrint(out); this.enterCsi(); return true; }
    if (b === 0x9d) { this.flushPrint(out); this.enterOsc(); return true; }
    if (b === 0x90) { this.flushPrint(out); this.enterDcs(); return true; }
    if (b === 0x98 || b === 0x9e || b === 0x9f) {
      this.flushPrint(out);
      this.state = "sos_pm_apc_string";
      this.stringBuf = "";
      return true;
    }
    return false;
  }

  private step(b: number, out: VtEvent[]): void {
    // 文字列を集めている最中は割り込みの範囲が狭い（本文に何が来てもよい）
    if (
      this.state === "osc_string" ||
      this.state === "dcs_passthrough" ||
      this.state === "dcs_ignore" ||
      this.state === "sos_pm_apc_string"
    ) {
      this.stringByte(b, out);
      return;
    }
    if (this.anywhere(b, out)) return;

    switch (this.state) {
      case "ground":
        this.ground(b, out);
        return;
      case "escape":
        this.escape(b, out);
        return;
      case "escape_intermediate":
        if (isIntermediate(b)) { this.intermediates += String.fromCharCode(b); return; }
        if (isC0(b)) { out.push({ kind: "execute", code: b }); return; }
        out.push({ kind: "esc", intermediates: this.intermediates, final: String.fromCharCode(b) });
        this.reset();
        return;
      case "csi_entry":
      case "csi_param":
      case "csi_intermediate":
      case "csi_ignore":
        this.csi(b, out);
        return;
      case "dcs_entry":
      case "dcs_param":
      case "dcs_intermediate":
        this.dcs(b);
        return;
    }
  }

  private ground(b: number, out: VtEvent[]): void {
    if (isC0(b) || b === 0x7f) {
      this.flushPrint(out);
      out.push({ kind: "execute", code: b });
      return;
    }
    // 0x80-0x9F も、8 ビット制御を開けていなければ**文字の一部**として扱う（既定）
    this.printBuf.push(b);
  }

  private escape(b: number, out: VtEvent[]): void {
    if (isC0(b)) { out.push({ kind: "execute", code: b }); return; }
    if (isIntermediate(b)) {
      this.state = "escape_intermediate";
      this.intermediates += String.fromCharCode(b);
      return;
    }
    switch (b) {
      case 0x5b: this.enterCsi(); return;          // '['
      case 0x5d: this.enterOsc(); return;          // ']'
      case 0x50: this.enterDcs(); return;          // 'P'
      case 0x58: case 0x5e: case 0x5f:             // 'X' SOS / '^' PM / '_' APC
        this.state = "sos_pm_apc_string";
        this.stringBuf = "";
        this.pendingEscInString = false;
        return;
      default:
        out.push({ kind: "esc", intermediates: "", final: String.fromCharCode(b) });
        this.reset();
        return;
    }
  }

  private csi(b: number, out: VtEvent[]): void {
    if (isC0(b)) { out.push({ kind: "execute", code: b }); return; }
    if (this.state === "csi_ignore") {
      if (isFinal(b)) this.reset();
      return;
    }
    if (this.state === "csi_entry" && isPrefix(b)) {
      this.prefix = String.fromCharCode(b);
      this.state = "csi_param";
      return;
    }
    if (isParam(b) && this.state !== "csi_intermediate") {
      // **プレフィクスがパラメータの途中に来たら不正**（状態図どおり捨てる）
      if (isPrefix(b)) { this.state = "csi_ignore"; return; }
      this.params += String.fromCharCode(b);
      this.state = "csi_param";
      return;
    }
    if (isIntermediate(b)) {
      this.intermediates += String.fromCharCode(b);
      this.state = "csi_intermediate";
      return;
    }
    if (this.state === "csi_intermediate" && isParam(b)) { this.state = "csi_ignore"; return; }
    if (isFinal(b)) {
      out.push({
        kind: "csi",
        prefix: this.prefix,
        params: parseParams(this.params),
        intermediates: this.intermediates,
        final: String.fromCharCode(b)
      });
      this.reset();
      return;
    }
    this.state = "csi_ignore";
  }

  private dcs(b: number): void {
    if (this.state === "dcs_entry" && isPrefix(b)) { this.prefix = String.fromCharCode(b); this.state = "dcs_param"; return; }
    if (isParam(b) && this.state !== "dcs_intermediate") { this.params += String.fromCharCode(b); this.state = "dcs_param"; return; }
    if (isIntermediate(b)) { this.intermediates += String.fromCharCode(b); this.state = "dcs_intermediate"; return; }
    if (isFinal(b)) {
      this.dcsFinal = String.fromCharCode(b);
      this.stringBuf = "";
      this.stringOverflow = false;
      this.pendingEscInString = false;
      this.state = "dcs_passthrough";
      return;
    }
    this.state = "dcs_ignore";
  }

  /** OSC / DCS / SOS-PM-APC の本文を集める。終端は `ST`（`ESC \`）か `BEL` */
  private stringByte(b: number, out: VtEvent[]): void {
    if (this.pendingEscInString) {
      this.pendingEscInString = false;
      if (b === 0x5c) { this.stringEnd(out); return; }
      // ST ではなかった: 本文を打ち切って、ESC から読み直す
      this.stringEnd(out);
      this.enterEscape();
      this.step(b, out);
      return;
    }
    if (b === 0x07 && this.state === "osc_string") { this.stringEnd(out); return; }
    if (b === 0x18 || b === 0x1a) { this.reset(); return; }
    if (b === 0x1b) { this.pendingEscInString = true; return; }
    if (this.eightBit && b === 0x9c) { this.stringEnd(out); return; }
    if (this.stringBuf.length >= this.maxString) { this.stringOverflow = true; return; }
    this.stringBuf += String.fromCharCode(b);
  }

  private stringEnd(out: VtEvent[]): void {
    if (this.state === "osc_string" && !this.stringOverflow) {
      const semi = this.stringBuf.indexOf(";");
      const head = semi < 0 ? this.stringBuf : this.stringBuf.slice(0, semi);
      const command = Number.parseInt(head, 10);
      out.push({
        kind: "osc",
        command: Number.isNaN(command) ? -1 : command,
        data: semi < 0 ? "" : this.stringBuf.slice(semi + 1)
      });
    } else if (this.state === "dcs_passthrough" && !this.stringOverflow) {
      out.push({
        kind: "dcs",
        params: parseParams(this.params),
        intermediates: this.intermediates,
        final: this.dcsFinal,
        data: this.stringBuf
      });
    }
    this.reset();
  }

  private enterEscape(): void {
    this.state = "escape";
    this.params = "";
    this.intermediates = "";
    this.prefix = "";
  }

  private enterCsi(): void {
    this.state = "csi_entry";
    this.params = "";
    this.intermediates = "";
    this.prefix = "";
  }

  private enterOsc(): void {
    this.state = "osc_string";
    this.stringBuf = "";
    this.stringOverflow = false;
    this.pendingEscInString = false;
  }

  private enterDcs(): void {
    this.state = "dcs_entry";
    this.params = "";
    this.intermediates = "";
    this.prefix = "";
    this.dcsFinal = "";
    this.pendingEscInString = false;
  }

  private reset(): void {
    this.state = "ground";
    this.params = "";
    this.intermediates = "";
    this.prefix = "";
    this.stringBuf = "";
    this.stringOverflow = false;
    this.pendingEscInString = false;
  }
}

const isC0 = (b: number): boolean => b <= 0x1f;
const isIntermediate = (b: number): boolean => b >= 0x20 && b <= 0x2f;
const isParam = (b: number): boolean => b >= 0x30 && b <= 0x3f;
const isPrefix = (b: number): boolean => b >= 0x3c && b <= 0x3f;
const isFinal = (b: number): boolean => b >= 0x40 && b <= 0x7e;

/**
 * `1;2` → `[1, 2]`、`;5` → `[undefined, 5]`、`38:2::1:2:3` → `[[38,2,undefined,1,2,3]]`。
 *
 * **空は `undefined`** にする（`0` と区別が要る——既定値が命令ごとに違うので、
 * 「省略された」ことを実行側へそのまま伝える）。
 */
export function parseParams(text: string): VtParam[] {
  if (text === "") return [];
  return text.split(";").map((piece) => {
    if (!piece.includes(":")) return num(piece);
    return piece.split(":").map(num);
  });
}

function num(s: string): number | undefined {
  if (s === "") return undefined;
  const v = Number.parseInt(s, 10);
  return Number.isNaN(v) ? undefined : v;
}
