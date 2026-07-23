import { Emitter } from "../util/emitter.js";
import { As400Error } from "../errors.js";
import { codecForCcsid } from "../codec/codec.js";
import { TcpTransport } from "../transport/tcp.js";
import type { Transport } from "../transport/types.js";
import { TelnetLayer } from "../telnet/telnet.js";
import { deviceEnvFor, printerTerminalTypeFor } from "./terminal-type.js";
import { ScsDecoder, type LogicalPage } from "../protocol/scs.js";

/** 受信した 1 スプール（帳票）。ジョブ完了ごとに 1 件。 */
export interface SpoolReport {
  id: string;
  pages: LogicalPage[];
  /** 受信した SCS 生バイト（保存/将来の PDF 変換用） */
  raw: Uint8Array;
}

export interface PrinterConnectOptions {
  host?: string;
  port?: number;
  tls?: boolean | { rejectUnauthorized?: boolean; ca?: string | string[] };
  /** 仮想プリンターデバイス名。省略時はホスト採番（QPADEVxxxx） */
  deviceName?: string | undefined;
  user?: string | undefined;
  password?: string | undefined;
  /** SBCS=37/273…。DBCS(1399) は後続対応 */
  ccsid?: number;
  /**
   * ホスト側で印刷データへ変換させる（Host Print Transform）。
   *
   * **指定すると届くのは SCS ではなく、その機種の印刷データ（PCL 等）になる。**
   * 実プリンターへそのまま流せる代わりに、当アプリでは中身を解釈できない
   * （帳票のページは作られず `raw` だけが載る）。値はプリンター機種（"*HP4" 等）。
   *
   * 装置に IGC などの能力が無くて書き出せない帳票も、変換を通せばホストが処理できる。
   */
  transformTo?: string;
  /** セッション ID（server が randomUUID を渡す。省略時は連番）。推測不能化のため */
  id?: string;
  connectTimeoutMs?: number;
  negotiationTimeoutMs?: number;
  /** テスト注入（ReplayTransport 等）。指定時は host 不要 */
  transport?: Transport;
  warn?: (message: string) => void;
}

interface PrinterSessionEvents extends Record<string, unknown[]> {
  report: [SpoolReport];
  status: [{ startupCode: string; connected: boolean }];
  closed: [string];
}

/** 起動応答コード（tn5250 printsession.c）。成功＝セッション確立、他＝失敗。 */
const SUCCESS_CODES = new Set(["I901", "I902", "I906"]);
const CODE_MEANING: Record<string, string> = {
  I901: "Virtual device has less function than source device.",
  I902: "Session successfully started.",
  I906: "Automatic sign-on requested, but not allowed. A sign-on screen will follow.",
  2702: "Device description not found.",
  8901: "Device not varied on.",
  8902: "Device not available.",
  8903: "Device not valid for session.",
  8906: "Session initiation failed.",
  8917: "Not authorized to object.",
  8922: "Negative response received.",
  8925: "Creation of device failed (IBMFONT/IBMTRANSFORM 欠落や権限不足の可能性).",
  8935: "Session rejected.",
  8936: "Security failure on session attempt.",
  8940: "Automatic configuration failed or not allowed."
};

/** クライアント→ホストの印刷完了応答（CLIENTO・opcode=PRINT_COMPLETE・空ペイロード） */
const PRINT_COMPLETE = Uint8Array.from([0x00, 0x0a, 0x12, 0xa0, 0x00, 0x12, 0x04, 0x00, 0x00, 0x01]);
/** ジョブ完了を示すレコード長（ヘッダのみ・印刷データなし） */
const JOB_COMPLETE_LEN = 0x11;

/**
 * TN5250E プリンターセッション。ホストのスプール出力を SCS として受信し、論理ページに展開して
 * ジョブ完了ごとに `report` を発火する。表示セッション（Session5250）とは別系統。
 *
 * 交渉・GDS 封筒・print-complete 応答は tn5250 lp5250d/printsession.c に準拠し、実機（PUB400）で
 * I902（Session successfully started）と実 SCS 受信を確認済み。IBMFONT/IBMTRANSFORM を申告しないと
 * デバイス作成が 8925 で失敗するため、交渉時に必ず送る。
 */
export class PrinterSession extends Emitter<PrinterSessionEvents> {
  readonly id: string;
  private telnet!: TelnetLayer;
  private readonly warn: (message: string) => void;
  private readonly codec;
  private readonly decoder: ScsDecoder;
  /** HPT で受けているか。true なら受信データは SCS ではないので解釈しない */
  private readonly transformed: boolean;
  private started = false;
  private startupCodeValue = "";
  private jobBytes: number[] = [];
  private closed = false;
  private readonly reportList: SpoolReport[] = [];
  private seq = 0;

  private constructor(private readonly opts: PrinterConnectOptions) {
    super();
    this.id = opts.id ?? `prt-${++sessionSeq}`;
    const ccsid = opts.ccsid ?? 37;
    this.codec = codecForCcsid(ccsid);
    this.decoder = new ScsDecoder(ccsid, opts.warn);
    this.transformed = opts.transformTo !== undefined;
    this.warn = opts.warn ?? (() => {});
  }

  static async connect(opts: PrinterConnectOptions): Promise<PrinterSession> {
    const session = new PrinterSession(opts);
    let transport: Transport;
    if (opts.transport) {
      transport = opts.transport;
    } else {
      if (opts.host === undefined) {
        throw new As400Error("CONNECT_FAILED", "host is required (or inject transport)");
      }
      transport = await TcpTransport.connect({
        host: opts.host,
        port: opts.port ?? (opts.tls ? 992 : 23),
        ...(opts.connectTimeoutMs !== undefined ? { connectTimeoutMs: opts.connectTimeoutMs } : {}),
        ...(opts.tls !== undefined ? { tls: opts.tls } : {})
      });
    }

    const ccsid = opts.ccsid ?? 37;
    const dev = deviceEnvFor(ccsid);
    session.telnet = new TelnetLayer(transport, {
      terminalType: printerTerminalTypeFor(ccsid),
      deviceName: opts.deviceName,
      user: opts.user,
      password: opts.password,
      kbdType: dev?.kbdType,
      codePage: dev?.codePage,
      charSet: dev?.charSet,
      ibmFont: "12",
      ibmTransform: opts.transformTo === undefined ? "0" : "1",
      ...(opts.transformTo !== undefined ? { ibmMfrTypMdl: opts.transformTo } : {})
    });

    const ready = new Promise<void>((resolve, reject) => {
      const timeoutMs = opts.negotiationTimeoutMs ?? 15_000;
      const timer = setTimeout(() => {
        session.telnet.close();
        reject(new As400Error("NEGOTIATION_TIMEOUT", `no startup response within ${timeoutMs}ms`));
      }, timeoutMs);
      session.onStartup = (err) => {
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      };
      session.telnet.onClose((reason) => {
        clearTimeout(timer);
        session.handleClose(reason);
        reject(new As400Error("SESSION_CLOSED", `closed during negotiation: ${reason}`));
      });
      session.telnet.onError((e) => session.warn(`transport error: ${e.message}`));
      session.telnet.onRecord((rec) => session.handleRecord(rec));
    });

    transport.start?.();
    await ready;
    session.telnet.onClose((reason) => session.handleClose(reason));
    return session;
  }

  private onStartup: ((err?: As400Error) => void) | undefined;

  get startupCode(): string {
    return this.startupCodeValue;
  }

  reports(): readonly SpoolReport[] {
    return this.reportList;
  }

  disconnect(): void {
    this.telnet?.close();
  }

  private handleRecord(rec: Uint8Array): void {
    if (!this.started) {
      this.handleStartup(rec);
      return;
    }
    // 印刷データ（opcode=1）。受信ごとに print-complete を返してチェーンを進める（CLEAR=2 は無視）
    const opcode = rec.length > 9 ? rec[9] : -1;
    if (opcode === 2) return; // CLEAR: バッファクリア
    this.telnet.sendRecord(PRINT_COMPLETE);
    if (rec.length === JOB_COMPLETE_LEN) {
      this.finishJob();
      return;
    }
    const payloadStart = 6 + (rec[6] ?? 4);
    for (let i = payloadStart; i < rec.length; i++) this.jobBytes.push(rec[i]!);
  }

  private handleStartup(rec: Uint8Array): void {
    this.started = true;
    const code = this.readResponseCode(rec);
    this.startupCodeValue = code;
    if (SUCCESS_CODES.has(code)) {
      this.emit("status", { startupCode: code, connected: true });
      this.onStartup?.();
    } else {
      const meaning = CODE_MEANING[code] ?? "unknown startup response";
      this.onStartup?.(new As400Error("SESSION_REJECTED", `printer session rejected (${code}: ${meaning})`));
    }
  }

  /** 起動応答レコードの (6+data[6])+5 の 4 バイト EBCDIC を読む（printsession.c:222-235） */
  private readResponseCode(rec: Uint8Array): string {
    const o = 6 + (rec[6] ?? 4);
    if (o + 9 > rec.length) return "";
    return this.codec.decode(rec.subarray(o + 5, o + 9));
  }

  private finishJob(): void {
    const raw = Uint8Array.from(this.jobBytes);
    this.jobBytes = [];
    // **HPT では中身を解釈しない。** 届いているのは SCS ではなくプリンターの言語なので、
    // SCS として読むと意味のないページが並ぶ。印刷にはそのまま流すので raw だけで足りる。
    const pages = this.transformed ? [] : this.decoder.decode(raw);
    const report: SpoolReport = { id: `spool-${++this.seq}`, pages, raw };
    this.reportList.push(report);
    this.emit("report", report);
  }

  private handleClose(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.emit("closed", reason);
  }
}

let sessionSeq = 0;
