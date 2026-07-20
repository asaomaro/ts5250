/**
 * DDM サーバー（DRDA ポート 446 / TLS 448）とのソケット。
 *
 * **既存の `openHostConnection` は使えない**——あちらはフレーム長を
 * **4 バイト**ビッグエンディアンで読むが、DDM は **2 バイト**である（spec D4）。
 * 無理に共通化せず、共有するのはソケットを開く層の考え方だけにする。
 *
 * また DDM は 1 要求に対して**チェインされた複数フレーム**を返すことがあるため、
 * 「1 要求 = 1 応答」の `request()` ではなく **send / receive を分けた**形にする
 * （原典が入出力ストリームを別々に扱っているのと同じ理由）。
 */
import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { As400Error, withSocketHint } from "../errors.js";
import type { HostTlsOptions } from "./host-connection.js";

export interface DdmTransportOptions {
  host: string;
  port: number;
  tls?: boolean | HostTlsOptions;
  timeoutMs?: number;
}

export interface DdmTransport {
  /** フレームを送る（応答は待たない） */
  send(frame: Uint8Array): void;
  /** 次の完全なフレームを受け取る */
  receive(): Promise<Uint8Array>;
  close(): void;
}

function isCertError(err: NodeJS.ErrnoException): boolean {
  return typeof err.code === "string" && /CERT|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(err.code);
}

export function openDdmTransport(opts: DdmTransportOptions): Promise<DdmTransport> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  return new Promise((resolve, reject) => {
    const tlsOpts = typeof opts.tls === "object" ? opts.tls : {};
    const socket: Socket = opts.tls
      ? tlsConnect({
          host: opts.host,
          port: opts.port,
          servername: opts.host,
          rejectUnauthorized: tlsOpts.rejectUnauthorized ?? true,
          ...(tlsOpts.ca !== undefined ? { ca: tlsOpts.ca } : {})
        })
      : netConnect({ host: opts.host, port: opts.port });

    let buffer = Buffer.alloc(0);
    /** 受信済みで未消費のフレーム。要求より先に届くことがある（チェイン応答） */
    const ready: Uint8Array[] = [];
    let waiting: { resolve(f: Uint8Array): void; reject(e: Error): void } | undefined;
    let connected = false;
    let failure: Error | undefined;

    const fail = (err: Error): void => {
      failure ??= err;
      const w = waiting;
      waiting = undefined;
      if (w) w.reject(err);
      else if (!connected) reject(err);
    };

    socket.setTimeout(timeoutMs);
    socket.on("timeout", () =>
      fail(
        new As400Error(
          "CONNECT_FAILED",
          withSocketHint(
            `DDM server timed out after ${timeoutMs}ms (${opts.host}:${opts.port})`,
            "ETIMEDOUT"
          )
        )
      )
    );
    socket.on("error", (err: NodeJS.ErrnoException) =>
      fail(
        new As400Error(
          isCertError(err) ? "TLS_CERT_INVALID" : "CONNECT_FAILED",
          withSocketHint(
            `DDM server connection failed (${opts.host}:${opts.port}): ${err.message}`,
            err.code
          ),
          { cause: err }
        )
      )
    );
    socket.on("close", () => fail(new As400Error("CONNECT_FAILED", "DDM server closed the connection")));

    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      // **長さは 2 バイト**（ここが既存の host-connection との違い）
      while (buffer.length >= 2) {
        const len = buffer.readUInt16BE(0);
        if (len < 6) {
          fail(new As400Error("PROTOCOL_ERROR", `DDM server sent a bad frame length ${len}`));
          return;
        }
        if (buffer.length < len) return;
        const frame = new Uint8Array(buffer.subarray(0, len));
        buffer = buffer.subarray(len);
        const w = waiting;
        waiting = undefined;
        if (w) w.resolve(frame);
        else ready.push(frame);
      }
    });

    socket.on(opts.tls ? "secureConnect" : "connect", () => {
      connected = true;
      resolve({
        send(frame) {
          if (failure) throw failure;
          socket.write(Buffer.from(frame));
        },
        receive() {
          const queued = ready.shift();
          if (queued) return Promise.resolve(queued);
          if (failure) return Promise.reject(failure);
          if (waiting) {
            return Promise.reject(
              new As400Error("PROTOCOL_ERROR", "a DDM receive is already in flight")
            );
          }
          return new Promise<Uint8Array>((res, rej) => {
            waiting = { resolve: res, reject: rej };
          });
        },
        close() {
          connected = true; // close 後の "close" イベントで reject させない
          socket.destroy();
        }
      });
    });
  });
}
