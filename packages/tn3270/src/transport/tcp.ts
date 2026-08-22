import { Socket, connect as netConnect } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { As400Error, withSocketHint } from "@ts5250/base";
import type { Transport } from "./types.js";

/**
 * 平文 TCP / TLS の Transport 実装。
 *
 * **`node:*` を import してよいのは `transport/` だけ**（AGENTS.md の層規約。
 * `eslint.config.js` が `packages/tn3270/src/transport/**` を ignores に置いて担保している）。
 */
export interface TcpConnectOptions {
  host: string;
  port: number;
  /** TCP 接続確立までのタイムアウト（既定 15 秒） */
  connectTimeoutMs?: number;
  /** TLS（telnet over SSL）。true で既定検証、オブジェクトで詳細指定 */
  tls?: boolean | { rejectUnauthorized?: boolean; ca?: string | string[] };
}

/**
 * TCP キープアライブを始めるまでの無通信時間。
 *
 * ⚠ **これが無いと、無通信の接続が黙って死ぬ。** 途中の NAT やファイアウォールが
 * 落としても**どちらの端も気づかない**——送ろうとして初めて分かる。
 *
 * 実機で測って分かった（2026-08-22・`scripts/measure-printer-idle-drop.mjs`）:
 * 常駐プリンター（`@ts5250/tn5250`）は **15 分のアイドルで届かなくなる**。同じ実機で
 * 待ち行列監視は 45 分を越えられており、**あちらはキープアライブが入っていた**
 * （`hostserver/src/transport/host-connection.ts`）。入っていない方だけが落ちていた。
 *
 *
 * ⚠ **効き方は 2 つあり、主役は前者**:
 *
 *   1. **経路上の機器に「使っている」と見せ続ける**——NAT やファイアウォールの
 *      アイドル表を更新するので、そもそも落とされない
 *   2. 落とされた場合に**気づけるようにする**——ただし探査の間隔と回数は OS の設定なので、
 *      死んだと判定するまで**さらに数分**かかる（Linux の既定で 75 秒 × 9 回）。
 *      その間に届いた帳票は取りこぼす。だから「気づく」に頼らず「落とされない」を狙う
 *
 * 値はホストサーバー側と揃える——**同じ性質の待ちを別の値にしない**。
 */
const KEEPALIVE_DELAY_MS = 60_000;

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
      // **無通信でも生死が分かるようにする**（上の定数の注記）
      socket.setKeepAlive(true, KEEPALIVE_DELAY_MS);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(
          new As400Error(
            "CONNECT_FAILED",
            withSocketHint(`connect timeout after ${timeoutMs}ms (${opts.host}:${opts.port})`, "ETIMEDOUT")
          )
        );
      }, timeoutMs);
      socket.once("connect", () => {
        clearTimeout(timer);
        resolve(new TcpTransport(socket));
      });
      socket.once("error", (err: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        reject(
          new As400Error(
            "CONNECT_FAILED",
            withSocketHint(`connect failed (${opts.host}:${opts.port}): ${err.message}`, err.code),
            { cause: err }
          )
        );
      });
    });
  }

  private static connectTls(opts: TcpConnectOptions): Promise<TcpTransport> {
    const timeoutMs = opts.connectTimeoutMs ?? 15_000;
    const tlsOpts = typeof opts.tls === "object" ? opts.tls : {};
    // 証明書検証は既定 ON（rejectUnauthorized:false は明示オプトイン）
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
      // **無通信でも生死が分かるようにする**（上の定数の注記）
      socket.setKeepAlive(true, KEEPALIVE_DELAY_MS);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(
          new As400Error(
            "CONNECT_FAILED",
            withSocketHint(`TLS connect timeout after ${timeoutMs}ms (${opts.host}:${opts.port})`, "ETIMEDOUT")
          )
        );
      }, timeoutMs);
      socket.once("secureConnect", () => {
        clearTimeout(timer);
        resolve(new TcpTransport(socket));
      });
      socket.once("error", (err) => {
        clearTimeout(timer);
        const certErr = /certificate|self.signed|unable to verify|CERT_/i.test(err.message);
        reject(
          new As400Error(
            certErr ? "TLS_CERT_INVALID" : "CONNECT_FAILED",
            `TLS connect failed (${opts.host}:${opts.port}): ${err.message}`,
            { cause: err }
          )
        );
      });
    });
  }

  send(data: Uint8Array): void {
    if (this.closed) throw new As400Error("SESSION_CLOSED", "transport is closed");
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
