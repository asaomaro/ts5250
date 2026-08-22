import { As400Error, childLog, deviceEnvFor } from "@ts5250/base";
import { VtParser } from "../protocol/parser.js";
import { VtTerminal } from "../screen/terminal.js";
import type { VtSnapshot } from "../screen/types.js";
import { encodeKey, encodeMouse, encodePaste, type VtKeyEvent, type VtMouseEvent } from "../input/keys.js";
import { encodeText, type VtEncoding } from "../text/codec.js";
import { VtTelnet } from "../telnet/telnet.js";
import { TcpTransport, type TcpConnectOptions } from "../transport/tcp.js";
import type { Transport } from "../transport/types.js";
import { Emitter } from "./emitter.js";

const log = childLog({ component: "vt-session" });

/**
 * **VT の表示セッション。**——telnet・パーサ・画面・打鍵を 1 本に繋ぐ。
 *
 * ```
 * ホスト → transport → telnet.receive（交渉を抜く）→ parser.feed（命令に割る）
 *        → terminal.handle（画面に効かせる）→ 返答があれば telnet.sendData
 * 打鍵   → encodeKey（モードで分岐）→ telnet.sendData → ホスト
 * ```
 *
 * **クライアントは自分で画面を書かない。** 打った文字が見えるのは、ホストがエコーを
 * 返してきたときだけ（`ECHO` をホストが握る＝文字モード）。5250 / 3270 との最大の違い。
 */
export interface VtSessionOptions {
  host: string;
  port?: number;
  tls?: TcpConnectOptions["tls"];
  rows?: number;
  cols?: number;
  /** 受信・送信の符号化（既定 `utf-8`） */
  encoding?: VtEncoding;
  /** 申告する端末タイプの候補。**IBM i には `["VT220"]`** を渡す（research 1.1） */
  terminalTypes?: readonly string[];
  /** IBM i にコードページを申告するための CCSID（`deviceEnvFor` で引く） */
  ccsid?: number;
  /** RFC 4777 の装置名（IBM i 向け） */
  deviceName?: string;
  /** スクロールバックの行数（既定 1,000） */
  scrollback?: number;
  /**
   * 打鍵を 1 文字ずつ送るときの間隔（ミリ秒）。
   * **IBM i と判定したら既定 20ms**（research 1.4: 一括で流すと欄の移動が間に合わず取りこぼす）。
   * 明示すればその値、`0` なら間を空けない。
   */
  writeDelayMs?: number;
  connectTimeoutMs?: number;
  warn?: (message: string) => void;
}

export interface VtSessionEvents extends Record<string, unknown[]> {
  /** 画面が変わった（描き直しの合図） */
  screen: [VtSnapshot];
  /** `OSC 0/2` のタイトル */
  title: [string];
  bell: [];
  close: [string];
  error: [Error];
}

const IBMI_WRITE_DELAY_MS = 20;

export class VtSession {
  private readonly emitter = new Emitter<VtSessionEvents>();
  private readonly parser: VtParser;
  readonly terminal: VtTerminal;
  private telnet: VtTelnet | undefined;
  private transport: Transport | undefined;
  private closed = false;
  /** 打鍵を順に流すための待ち行列（間合いを空けるときに使う） */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly opts: VtSessionOptions) {
    const rows = opts.rows ?? 24;
    const cols = opts.cols ?? 80;
    this.parser = new VtParser({ encoding: opts.encoding ?? "utf-8" });
    this.terminal = new VtTerminal(rows, cols, opts.scrollback ?? 1000);
    this.terminal.onTitle = (t) => this.emitter.emit("title", t);
    this.terminal.onBell = () => this.emitter.emit("bell");
  }

  on<K extends keyof VtSessionEvents>(e: K, fn: (...a: VtSessionEvents[K]) => void): void {
    this.emitter.on(e, fn);
  }

  /** ホストが `ECHO` を握ったか＝文字モードが成立しているか */
  get hostEchoes(): boolean {
    return this.telnet?.hostEchoes ?? false;
  }

  /** IBM i か（`DO NEW-ENVIRON` を出してくるのは IBM i） */
  get isIbmI(): boolean {
    return this.telnet?.isIbmI ?? false;
  }

  get terminalType(): string {
    return this.telnet?.terminalType ?? "";
  }

  snapshot(): VtSnapshot {
    return this.terminal.snapshot();
  }

  static async connect(opts: VtSessionOptions): Promise<VtSession> {
    const s = new VtSession(opts);
    await s.open();
    return s;
  }

  async open(): Promise<void> {
    const transport = await TcpTransport.connect({
      host: this.opts.host,
      port: this.opts.port ?? 23,
      ...(this.opts.tls !== undefined ? { tls: this.opts.tls } : {}),
      ...(this.opts.connectTimeoutMs !== undefined ? { connectTimeoutMs: this.opts.connectTimeoutMs } : {})
    });
    this.attach(transport);
  }

  /** 任意の `Transport` に繋ぐ（試験・再生用） */
  attach(transport: Transport): void {
    this.transport = transport;
    const dev = this.opts.ccsid !== undefined ? deviceEnvFor(this.opts.ccsid) : undefined;
    this.telnet = new VtTelnet(transport, {
      rows: this.terminal.buffer.rows,
      cols: this.terminal.buffer.cols,
      ...(this.opts.terminalTypes !== undefined ? { terminalTypes: this.opts.terminalTypes } : {}),
      ...(dev !== undefined ? { deviceEnv: dev } : {}),
      ...(this.opts.deviceName !== undefined ? { deviceName: this.opts.deviceName } : {}),
      ...(this.opts.warn !== undefined ? { warn: this.opts.warn } : {})
    });
    transport.onData((bytes) => this.receive(bytes));
    transport.onClose((reason) => this.handleClose(reason));
    transport.onError((err) => this.emitter.emit("error", err));
    transport.start?.();
  }

  private receive(bytes: Uint8Array): void {
    const telnet = this.telnet;
    if (telnet === undefined) return;
    try {
      const data = telnet.receive(bytes);
      if (data.length === 0) return;
      const replies = this.terminal.handle(this.parser.feed(data));
      // **問われたら答える**（DA / DSR / CPR）。返さないとホストが待つ
      for (const r of replies) telnet.sendData(r);
      this.emitter.emit("screen", this.terminal.snapshot());
    } catch (e) {
      // **1 バイトの化けで接続を落とさない**——端末は壊れた出力でも動き続ける
      const err = e instanceof Error ? e : new Error(String(e));
      log.warn(`受信の処理で例外: ${err.message}`);
      this.emitter.emit("error", err);
    }
  }

  // ---- 送る ----

  /** 打鍵を 1 つ送る */
  key(e: VtKeyEvent): void {
    this.write(encodeKey(e, this.terminal.modes, this.opts.encoding ?? "utf-8"));
  }

  /** 文字を送る（IME の確定など、まとまった文字列でもよい） */
  text(s: string): void {
    if (s === "") return;
    const { bytes, dropped } = encodeText(s, this.opts.encoding ?? "utf-8");
    if (dropped.length > 0) {
      this.opts.warn?.(`この符号化では送れない文字を ? に置き換えました: ${dropped.join("")}`);
    }
    this.write(bytes);
  }

  /** 貼り付け（`?2004` が有効なら包む） */
  paste(s: string): void {
    this.write(encodePaste(s, this.terminal.modes, this.opts.encoding ?? "utf-8"));
  }

  /** マウス（報告が切れていれば何も送らない） */
  mouse(e: VtMouseEvent): void {
    const bytes = encodeMouse(e, this.terminal.modes);
    if (bytes.length > 0) this.write(bytes);
  }

  /** 生のバイト列を送る（試験・診断用） */
  sendRaw(bytes: Uint8Array): void {
    this.write(bytes);
  }

  /**
   * 送信。**IBM i には 1 バイトずつ間を空けて流す**（spec D12）。
   *
   * research 1.4 で、サインオン画面に `ユーザー名 TAB パスワード CR` を一括で流すと
   * 欄の移動が間に合わずパスワードが入らなかった。**利用側に間合いの責任を持たせない**ため
   * ここで吸収する。
   */
  private write(bytes: Uint8Array): void {
    const telnet = this.telnet;
    if (telnet === undefined || this.closed) {
      throw new As400Error("SESSION_CLOSED", "セッションは閉じています");
    }
    if (bytes.length === 0) return;
    const delay = this.writeDelay();
    if (delay <= 0 || bytes.length === 1) {
      telnet.sendData(bytes);
      return;
    }
    // **順序を保つ**——待ち行列に繋いで、前の送信が終わってから次を出す
    this.writeChain = this.writeChain.then(async () => {
      for (const b of bytes) {
        if (this.closed) return;
        telnet.sendData(Uint8Array.of(b));
        await sleep(delay);
      }
    });
    void this.writeChain.catch((e: unknown) => {
      this.emitter.emit("error", e instanceof Error ? e : new Error(String(e)));
    });
  }

  private writeDelay(): number {
    if (this.opts.writeDelayMs !== undefined) return this.opts.writeDelayMs;
    return this.isIbmI ? IBMI_WRITE_DELAY_MS : 0;
  }

  // ---- 大きさ ----

  /** 画面の大きさを変え、ホストへも伝える（`stty size` がこれで変わる） */
  resize(rows: number, cols: number): void {
    this.terminal.resize(rows, cols);
    this.telnet?.setWindowSize(rows, cols);
    this.emitter.emit("screen", this.terminal.snapshot());
  }

  close(): void {
    if (this.closed) return;
    this.transport?.close();
  }

  private handleClose(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    // 持ち越していた文字があれば最後に反映してから閉じる
    const tail = this.parser.end();
    if (tail.length > 0) {
      this.terminal.handle(tail);
      this.emitter.emit("screen", this.terminal.snapshot());
    }
    this.emitter.emit("close", this.annotate(reason));
  }

  /**
   * 切断の理由に、**分かっている手掛かりを足す**。
   *
   * research 1.2: SR-OSAKA は交渉まで進んでから画面を 1 バイトも出さずに閉じる。
   * ホスト側でサブシステムが仮想装置をオフにしているのが原因で、これが分からないと
   * 「繋がらない」としか言えない。
   */
  private annotate(reason: string): string {
    const gotScreen = this.terminal.buffer.displayLines.some((line) =>
      line.some((c) => c.char !== " " && c.char !== "")
    );
    if (gotScreen || !this.isIbmI) return reason;
    return (
      `${reason}（IBM i と交渉できたが画面が届かないまま閉じました。` +
      `ホスト側で VT の仮想装置にジョブが割り当てられていない可能性があります` +
      `——QSYSOPR に CPF1194 等が出ていないか確認してください）`
    );
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
