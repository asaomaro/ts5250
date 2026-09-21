import { Emitter } from "./emitter.js";
import { As400Error } from "@ts5250/base";
import { codecForCcsid } from "@ts5250/ebcdic";
import { TcpTransport } from "../transport/tcp.js";
import type { Transport } from "../transport/types.js";
import { TelnetLayer } from "../telnet/telnet.js";
import {
  parseStartupResponse,
  startupCodeMeaning,
  STARTUP_SUCCESS_CODES
} from "../telnet/startup-record.js";
import { printerDeclaration } from "./terminal-type.js";
import { ScsDecoder, type LogicalPage } from "@ts5250/scs";

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

/**
 * プリンター固有の補足。共通の意味は `startupCodeMeaning`（`telnet/startup-record.ts`）にある。
 * 8925 はプリンターでだけ出やすい（IBMFONT/IBMTRANSFORM の申告漏れ）ので、ここで上書きする。
 */
const PRINTER_CODE_MEANING: Record<string, string> = {
  8925: "Creation of device failed (IBMFONT/IBMTRANSFORM 欠落や権限不足の可能性).",
  8936: "Security failure on session attempt."
};

/**
 * クライアント→ホストの応答（ACS `DS5250P` の `NO_ERROR` / `CLEAR_PROCESSED`。`20260921-printer-acs-declaration`）。
 * 予約の 2 バイトは **0x0102**（~~0x0012~~ は tn5250 lp5250d 由来で ACS と違った）。IAC EOR は telnet 層が付ける。
 */
const NO_ERROR = Uint8Array.from([0x00, 0x0a, 0x12, 0xa0, 0x01, 0x02, 0x04, 0x00, 0x00, 0x01]);
const CLEAR_PROCESSED = Uint8Array.from([0x00, 0x0a, 0x12, 0xa0, 0x01, 0x02, 0x04, 0x00, 0x00, 0x02]);
/** 5250 ヘッダの opcode（印刷データ / CLEAR） */
const OP_PRINT = 1;
const OP_CLEAR = 2;
/** ヘッダのフラグ 1（バイト 7）の「ジョブの終わり」 */
const FLAG_END_OF_JOB = 0x08;
/** ヘッダのバイト 4（ACS `miscFlags1`）の「終了のレコード」 */
const MISC_TERMINATION = 0x40;

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
  /**
   * **いまの応答**（ACS `DS5250.response_string`）。レコードを処理するたびに、決まっていればこれを返す。
   * ACS は**一度決まった応答を消さない**——データを書くと NO_ERROR、CLEAR で CLEAR_PROCESSED になり、以後の
   * レコード（ジョブの終わりなど、応答を変えないもの）にも同じものを返す。起動の直後は何も返さない。
   */
  private response: Uint8Array | undefined;
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

    // **申告は ACS と同じ組**（端末タイプと USERVAR の並び。`printerDeclaration`）。以前は KBDTYPE / CODEPAGE /
    // CHARSET・IBMFONT=12・IBMSENDCONFREC を送っていて、DBCS では装置が 3812 にされ日本語の帳票が CPA3303 で止まった
    const decl = printerDeclaration(opts.ccsid ?? 37, opts.transformTo);
    session.telnet = new TelnetLayer(transport, {
      terminalType: decl.terminalType,
      deviceName: opts.deviceName,
      user: opts.user,
      password: opts.password,
      userVars: decl.userVars,
      sendConfRec: false
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
    // **ACS `DS5250P.processPassthru` と同じ振り分け**（`20260921-printer-acs-declaration` research F5）。
    // ACS は opcode より先にヘッダのバイト 4（`miscFlags1`）を見て、0x40（終了のレコード）なら何もしない
    // （起動の応答 0x80 / 0x90 は `started` で先に分けている）。どちらでも応答は下で返す
    const opcode = rec.length > 9 ? rec[9] : -1;
    if (rec[4] === MISC_TERMINATION) {
      // 何もしない
    } else if (opcode === OP_CLEAR) {
      // CLEAR（印刷の取り消し・保留など）: 受けかけのジョブを閉じ、CLEAR_PROCESSED を返す（`processClear` → `sendEOJ`）。
      // ~~応答しない~~ だとホストは応答を待つ。閉じないと前のジョブの断片が次の帳票に混ざる
      if (this.jobBytes.length > 0) this.finishJob();
      this.response = CLEAR_PROCESSED;
    } else if (opcode === OP_PRINT) {
      const payload = rec.subarray(6 + (rec[6] ?? 4));
      // **ジョブの終わりはフラグ 0x08 ＋ 本体が空か 0x00 だけ**（`processScs`）。~~レコード長 17~~ だけを見ていたので、
      // 本体の無い 16 バイトの終わり（日本語機の 5553 で実測）では帳票が確定しなかった
      const endOfJob = rec[7] === FLAG_END_OF_JOB && (payload.length === 0 || (payload.length === 1 && payload[0] === 0));
      // 応答は変えない（ACS も `sendEOJ` だけ）。**データの無いジョブは閉じない**——ACS の `sendEOJ` は印刷中
      // （`inJob`）でなければ何もしない。閉じると空の帳票ができ、自動 PDF・自動印刷に白紙が出る
      // （データ → 終わり → CLEAR → 終わり、の並びで起きた。独立点検の指摘）
      if (endOfJob) {
        if (this.jobBytes.length > 0) this.finishJob();
      }
      else if (payload.length > 0) {
        for (const b of payload) this.jobBytes.push(b);
        this.response = NO_ERROR; // 書けた（ACS は `PrintHostData.write` が NO_ERROR にする）
      }
    }
    // その他の opcode は何もしない（ACS も処理しない。~~本体を SCS として足す~~）
    if (this.response) this.telnet.sendRecord(this.response);
  }

  private handleStartup(rec: Uint8Array): void {
    this.started = true;
    // 解析は表示セッションと共有する（読み位置を 2 か所に書くと片方だけずれる）
    const startup = parseStartupResponse(rec, this.codec);
    const code = startup?.code ?? "";
    this.startupCodeValue = code;
    if (STARTUP_SUCCESS_CODES.has(code)) {
      this.emit("status", { startupCode: code, connected: true });
      this.onStartup?.();
    } else {
      const meaning = PRINTER_CODE_MEANING[code] ?? startupCodeMeaning(code);
      this.onStartup?.(new As400Error("SESSION_REJECTED", `printer session rejected (${code}: ${meaning})`));
    }
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
