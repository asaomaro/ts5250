import { childLog, type DeviceEnv } from "@ts5250/base";
import type { Transport } from "../transport/types.js";
import {
  CMD, ENV_IS, ENV_SEND, ENV_USERVAR, ENV_VALUE, IAC, OPT,
  optionName, TTYPE_IS, TTYPE_SEND
} from "./constants.js";

const log = childLog({ component: "vt-telnet" });

/**
 * **VT の telnet 交渉。**
 *
 * 5250 / 3270 と決定的に違うのは、**`ECHO` と `SGA` をホストが握ることで文字モードが成立する**点。
 * ホストが `WILL ECHO` を出したら `DO ECHO` を返す——以後、打った文字は画面に出ず、
 * ホストがエコーを返してきてはじめて出る。
 *
 * ## 端末タイプの申告（research 1.1）
 *
 * ホストは `SB TERMINAL-TYPE SEND` を**候補が尽きるまで繰り返す**。
 * 同じ名前を 2 度返すと「これ以上は無い」の合図になる。
 *
 * IBM i は `VT220` / `VT100` を **1 回で受ける**が、`xterm-256color` は知らないので
 * 2 度目を要求してくる。**IBM i には `VT220` を申告する**（利用側が決める。既定は
 * `xterm-256color` → `xterm` → `vt220` → `vt100` の順に候補を出す）。
 *
 * ## NEW-ENVIRON は受ける（research 1.3）
 *
 * IBM i は `DO NEW-ENVIRON` を出す。**これが IBM i の見分け**でもある（5250 / 3270 と同じ）。
 * RFC 2877 の `KBDTYPE` / `CODEPAGE` / `CHARSET` を申告しないと、ホストがシステム既定の
 * コードページで装置を作り、記号入りのパスワードが化けて **CPF1120** で落ちる。
 */
export interface VtTelnetOptions {
  /** 申告する端末タイプの候補（先頭から順に出す）。既定は xterm 系 → VT 系 */
  terminalTypes?: readonly string[];
  /** 画面の大きさ（NAWS で申告する） */
  rows?: number;
  cols?: number;
  /** RFC 2877 のデバイス属性（IBM i 向け。`@ts5250/base` の `deviceEnvFor` で引く） */
  deviceEnv?: DeviceEnv;
  /** RFC 4777 の装置名（IBM i 向け） */
  deviceName?: string;
  /** 8 ビット透過を要求するか。既定 true（UTF-8 と日本語に要る） */
  binary?: boolean;
  warn?: (message: string) => void;
}

const DEFAULT_TTYPES = ["xterm-256color", "xterm", "vt220", "vt100"] as const;

export class VtTelnet {
  private readonly types: readonly string[];
  private typeIndex = 0;
  private rows: number;
  private cols: number;

  /** ホストが握ったオプション（こちらが `DO` を返したもの） */
  private readonly hostWill = new Set<number>();
  /** こちらが握ったオプション（`WILL` を返したもの） */
  private readonly weWill = new Set<number>();

  /** **IBM i の見分け**——`DO NEW-ENVIRON` を出してくるのは IBM i（5250 / 3270 と同じ） */
  private sawNewEnviron = false;

  private buf: number[] = [];

  constructor(
    private readonly transport: Transport,
    private readonly opts: VtTelnetOptions = {}
  ) {
    this.types = opts.terminalTypes ?? DEFAULT_TTYPES;
    this.rows = opts.rows ?? 24;
    this.cols = opts.cols ?? 80;
  }

  /** ホストが `ECHO` を握ったか＝**文字モードが成立しているか** */
  get hostEchoes(): boolean {
    return this.hostWill.has(OPT.ECHO);
  }

  get negotiatedBinary(): boolean {
    return this.hostWill.has(OPT.BINARY) && this.weWill.has(OPT.BINARY);
  }

  get isIbmI(): boolean {
    return this.sawNewEnviron;
  }

  /** いま申告している端末タイプ */
  get terminalType(): string {
    return this.types[Math.min(this.typeIndex, this.types.length - 1)] ?? "vt100";
  }

  /**
   * 受け取ったバイト列から交渉を抜き、**アプリのデータだけ**を返す。
   * `IAC IAC` は 1 つの 0xFF に戻す。
   */
  receive(data: Uint8Array): Uint8Array {
    const out: number[] = [];
    for (const b of data) this.buf.push(b);

    let i = 0;
    while (i < this.buf.length) {
      const b = this.buf[i]!;
      if (b !== IAC) { out.push(b); i++; continue; }

      const c = this.buf[i + 1];
      if (c === undefined) break;             // 続きを待つ
      if (c === IAC) { out.push(IAC); i += 2; continue; }

      if (c === CMD.WILL || c === CMD.WONT || c === CMD.DO || c === CMD.DONT) {
        const opt = this.buf[i + 2];
        if (opt === undefined) break;         // 続きを待つ
        this.negotiate(c, opt);
        i += 3;
        continue;
      }

      if (c === CMD.SB) {
        const end = this.findSubnegotiationEnd(i + 2);
        if (end < 0) break;                   // 続きを待つ
        this.subnegotiate(this.buf.slice(i + 2, end));
        i = end + 2;
        continue;
      }

      // 単独コマンド（NOP / GA / DM …）は読み飛ばす
      i += 2;
    }

    this.buf = this.buf.slice(i);
    return Uint8Array.from(out);
  }

  /** `IAC SE` の位置（見つからなければ -1） */
  private findSubnegotiationEnd(from: number): number {
    for (let j = from; j + 1 < this.buf.length; j++) {
      if (this.buf[j] === IAC && this.buf[j + 1] === CMD.SE) return j;
    }
    return -1;
  }

  private negotiate(cmd: number, opt: number): void {
    log.debug(`<< ${cmd === CMD.DO ? "DO" : cmd === CMD.DONT ? "DONT" : cmd === CMD.WILL ? "WILL" : "WONT"} ${optionName(opt)}`);
    if (cmd === CMD.DO) {
      if (opt === OPT.NEW_ENVIRON) this.sawNewEnviron = true;
      const ok = this.weCanDo(opt);
      this.send([IAC, ok ? CMD.WILL : CMD.WONT, opt]);
      if (!ok) return;
      this.weWill.add(opt);
      // **NAWS は握った直後に必ず 1 度送る**（送らないホストは 80x24 と決め打つ）
      if (opt === OPT.NAWS) this.sendWindowSize();
      return;
    }
    if (cmd === CMD.DONT) {
      this.weWill.delete(opt);
      this.send([IAC, CMD.WONT, opt]);
      return;
    }
    if (cmd === CMD.WILL) {
      const ok = this.weAccept(opt);
      this.send([IAC, ok ? CMD.DO : CMD.DONT, opt]);
      if (ok) this.hostWill.add(opt);
      return;
    }
    // WONT
    this.hostWill.delete(opt);
    this.send([IAC, CMD.DONT, opt]);
  }

  /** こちらが提供できるもの */
  private weCanDo(opt: number): boolean {
    if (opt === OPT.BINARY) return this.opts.binary !== false;
    return (
      opt === OPT.TERMINAL_TYPE ||
      opt === OPT.NAWS ||
      opt === OPT.TERMINAL_SPEED ||
      opt === OPT.NEW_ENVIRON
    );
  }

  /** ホストに握らせてよいもの。**`ECHO` と `SGA` が文字モードの本体** */
  private weAccept(opt: number): boolean {
    if (opt === OPT.BINARY) return this.opts.binary !== false;
    return opt === OPT.ECHO || opt === OPT.SGA;
  }

  private subnegotiate(body: readonly number[]): void {
    const opt = body[0];
    if (opt === OPT.TERMINAL_TYPE && body[1] === TTYPE_SEND) {
      const name = this.terminalType;
      log.debug(`>> SB TERMINAL-TYPE IS ${name}`);
      this.send([IAC, CMD.SB, OPT.TERMINAL_TYPE, TTYPE_IS, ...ascii(name), IAC, CMD.SE]);
      // **次に聞かれたら次の候補**。尽きたら同じ名前を返して「これ以上は無い」と伝える
      if (this.typeIndex < this.types.length - 1) this.typeIndex++;
      return;
    }
    if (opt === OPT.TERMINAL_SPEED && body[1] === 1) {
      this.send([IAC, CMD.SB, OPT.TERMINAL_SPEED, 0, ...ascii("38400,38400"), IAC, CMD.SE]);
      return;
    }
    if (opt === OPT.NEW_ENVIRON && body[1] === ENV_SEND) {
      this.sendEnviron();
      return;
    }
  }

  /**
   * NEW-ENVIRON の `SEND` に応える。
   *
   * **要求された変数を選り分けず、こちらが申告したいものを `IS` で返す**
   * （RFC 1572 は要求に無い変数を返すことを許す）。IBM i はこれで装置を作る。
   */
  private sendEnviron(): void {
    const payload: number[] = [OPT.NEW_ENVIRON, ENV_IS];
    const put = (name: string, value: string): void => {
      payload.push(ENV_USERVAR, ...ascii(name), ENV_VALUE, ...ascii(value));
    };
    if (this.opts.deviceName !== undefined) put("DEVNAME", this.opts.deviceName);
    const dev = this.opts.deviceEnv;
    if (dev !== undefined) {
      // **KBDTYPE は必須**——CODEPAGE/CHARSET だけでは反応しないホストがある（5250 の実機知見）
      put("KBDTYPE", dev.kbdType);
      put("CODEPAGE", String(dev.codePage));
      put("CHARSET", String(dev.charSet));
    }
    const out: number[] = [IAC, CMD.SB];
    for (const b of payload) {
      out.push(b);
      if (b === IAC) out.push(IAC);
    }
    out.push(IAC, CMD.SE);
    log.debug(`>> SB NEW-ENVIRON IS (${payload.length} bytes)`);
    this.transport.send(Uint8Array.from(out));
  }

  /** 画面の大きさが変わったらホストへ伝える（`stty size` がこれで変わる） */
  setWindowSize(rows: number, cols: number): void {
    this.rows = rows;
    this.cols = cols;
    if (this.weWill.has(OPT.NAWS)) this.sendWindowSize();
  }

  private sendWindowSize(): void {
    const body = [
      OPT.NAWS,
      (this.cols >> 8) & 0xff, this.cols & 0xff,
      (this.rows >> 8) & 0xff, this.rows & 0xff
    ];
    const out: number[] = [IAC, CMD.SB];
    for (const b of body) {
      out.push(b);
      if (b === IAC) out.push(IAC);
    }
    out.push(IAC, CMD.SE);
    this.transport.send(Uint8Array.from(out));
  }

  /**
   * アプリのデータを送る。**`0xFF` は `IAC IAC` に脱出する**
   * （日本語を 8 ビットで送ると必ず出る）。
   */
  sendData(bytes: Uint8Array): void {
    let needsEscape = false;
    for (const b of bytes) {
      if (b === IAC) { needsEscape = true; break; }
    }
    if (!needsEscape) { this.transport.send(bytes); return; }
    const out: number[] = [];
    for (const b of bytes) {
      out.push(b);
      if (b === IAC) out.push(IAC);
    }
    this.transport.send(Uint8Array.from(out));
  }

  private send(bytes: number[]): void {
    this.transport.send(Uint8Array.from(bytes));
  }
}

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0) & 0xff);
