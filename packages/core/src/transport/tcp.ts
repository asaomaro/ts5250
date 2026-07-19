import { Socket, connect as netConnect } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { Tn5250Error, withSocketHint } from "../errors.js";
import type { Transport } from "./types.js";

export interface TcpConnectOptions {
  host: string;
  port: number;
  /** TCP 接続確立までのタイムアウト（既定 15 秒） */
  connectTimeoutMs?: number;
  /** TLS（telnet over SSL）。true で既定検証、オブジェクトで詳細指定 */
  tls?: boolean | { rejectUnauthorized?: boolean; ca?: string | string[] };
}

/** 平文 TCP / TLS の Transport 実装（node:net・node:tls） */
export class TcpTransport implements Transport {
  private dataFn: ((data: Uint8Array) => void) | undefined;
  private closeFn: ((reason: string) => void) | undefined;
  private errorFn: ((err: Error) => void) | undefined;
  private closed = false;

  private constructor(private readonly socket: Socket) {
    socket.on("data", (chunk: Buffer) => this.dataFn?.(new Uint8Array(chunk)));
    socket.on("error", (err: Error) => this.errorFn?.(err));
    socket.on("close", () => this.emitClose("socket closed"));
  }

  static connect(opts: TcpConnectOptions): Promise<TcpTransport> {
    return opts.tls ? this.connectTls(opts) : this.connectPlain(opts);
  }

  private static connectPlain(opts: TcpConnectOptions): Promise<TcpTransport> {
    const timeoutMs = opts.connectTimeoutMs ?? 15_000;
    return new Promise((resolve, reject) => {
      const socket = netConnect({ host: opts.host, port: opts.port });
      socket.setNoDelay(true);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(
          new Tn5250Error("CONNECT_FAILED", `connect timeout after ${timeoutMs}ms (${opts.host}:${opts.port})`)
        );
      }, timeoutMs);
      socket.once("connect", () => {
        clearTimeout(timer);
        resolve(new TcpTransport(socket));
      });
      socket.once("error", (err: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        reject(
          new Tn5250Error("CONNECT_FAILED", withSocketHint(`connect failed (${opts.host}:${opts.port}): ${err.message}`, err.code), {
            cause: err
          })
        );
      });
    });
  }

  private static connectTls(opts: TcpConnectOptions): Promise<TcpTransport> {
    const timeoutMs = opts.connectTimeoutMs ?? 15_000;
    const tlsOpts = typeof opts.tls === "object" ? opts.tls : {};
    // 証明書検証は既定 ON（spec: rejectUnauthorized: false は明示オプトイン）
    const rejectUnauthorized = tlsOpts.rejectUnauthorized ?? true;
    return new Promise((resolve, reject) => {
      const socket: TLSSocket = tlsConnect({
        host: opts.host,
        port: opts.port,
        servername: opts.host,
        rejectUnauthorized,
        ...(tlsOpts.ca !== undefined ? { ca: tlsOpts.ca } : {})
      });
      socket.setNoDelay(true);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Tn5250Error("CONNECT_FAILED", `TLS connect timeout after ${timeoutMs}ms (${opts.host}:${opts.port})`));
      }, timeoutMs);
      socket.once("secureConnect", () => {
        clearTimeout(timer);
        resolve(new TcpTransport(socket));
      });
      socket.once("error", (err) => {
        clearTimeout(timer);
        // 証明書検証失敗を区別する
        const certErr = /certificate|self.signed|unable to verify|CERT_/i.test(err.message);
        reject(
          new Tn5250Error(
            certErr ? "TLS_CERT_INVALID" : "CONNECT_FAILED",
            `TLS connect failed (${opts.host}:${opts.port}): ${err.message}`,
            { cause: err }
          )
        );
      });
    });
  }

  send(data: Uint8Array): void {
    if (this.closed) throw new Tn5250Error("SESSION_CLOSED", "transport is closed");
    this.socket.write(data);
  }

  close(): void {
    this.socket.destroy();
    this.emitClose("closed by client");
  }

  onData(fn: (data: Uint8Array) => void): void {
    this.dataFn = fn;
  }

  onClose(fn: (reason: string) => void): void {
    this.closeFn = fn;
  }

  onError(fn: (err: Error) => void): void {
    this.errorFn = fn;
  }

  private emitClose(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.closeFn?.(reason);
  }
}
