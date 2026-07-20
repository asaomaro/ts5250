/**
 * IBM i ホストサーバー向けの I/O（ソケットとフレーム分割）。
 *
 * design の方針どおり Node API はこの層に閉じ込め、`hostserver/` はピュアに保つ。
 * ホストサーバーのデータストリームは**先頭 4 バイトが全体長**の長さ前置フレームで、
 * 要求と応答が 1 対 1 に対応する（同時に複数を飛ばさない）。
 */
import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { As400Error, withSocketHint } from "../errors.js";

export interface HostTlsOptions {
  rejectUnauthorized?: boolean;
  ca?: string | string[];
}

export interface HostConnectionOptions {
  host: string;
  port: number;
  tls?: boolean | HostTlsOptions;
  timeoutMs?: number;
}

/** 1 往復ずつフレームをやり取りする接続 */
export interface HostConnection {
  /** フレームを送り、対応する応答フレームを返す */
  request(frame: Uint8Array): Promise<Uint8Array>;
  close(): void;
}

/** TLS のハンドシェイク・証明書に起因するエラーか */
function isCertError(err: NodeJS.ErrnoException): boolean {
  const code = err.code ?? "";
  return (
    code.startsWith("CERT_") ||
    code.startsWith("UNABLE_TO_") ||
    code.includes("CERTIFICATE") ||
    code === "ERR_TLS_CERT_ALTNAME_INVALID" ||
    code === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
    code === "SELF_SIGNED_CERT_IN_CHAIN"
  );
}

/** ホストサーバーへ接続する */
export function openHostConnection(opts: HostConnectionOptions): Promise<HostConnection> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  return new Promise((resolve, reject) => {
    const tlsOpts = typeof opts.tls === "object" ? opts.tls : {};
    const socket: Socket = opts.tls
      ? tlsConnect({
          host: opts.host,
          port: opts.port,
          servername: opts.host,
          // 証明書検証は既定 ON（無効化は明示オプトイン）
          rejectUnauthorized: tlsOpts.rejectUnauthorized ?? true,
          ...(tlsOpts.ca !== undefined ? { ca: tlsOpts.ca } : {})
        })
      : netConnect({ host: opts.host, port: opts.port });

    let buffer = Buffer.alloc(0);
    let pending: { resolve(f: Uint8Array): void; reject(e: Error): void } | undefined;
    let connected = false;

    const fail = (err: Error): void => {
      const p = pending;
      pending = undefined;
      if (p) p.reject(err);
      else if (!connected) reject(err);
    };

    socket.setTimeout(timeoutMs);
    socket.on("timeout", () =>
      fail(
        new As400Error(
          "CONNECT_FAILED",
          withSocketHint(
            `host server timed out after ${timeoutMs}ms (${opts.host}:${opts.port})`,
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
            `host server connection failed (${opts.host}:${opts.port}): ${err.message}`,
            err.code
          ),
          { cause: err }
        )
      )
    );
    socket.on("close", () =>
      fail(new As400Error("CONNECT_FAILED", "host server closed the connection"))
    );

    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const len = buffer.readUInt32BE(0);
        if (len < 4) {
          fail(new As400Error("PROTOCOL_ERROR", `host server sent a bad frame length ${len}`));
          return;
        }
        if (buffer.length < len) return;
        const frame = new Uint8Array(buffer.subarray(0, len));
        buffer = buffer.subarray(len);
        const p = pending;
        pending = undefined;
        // 要求に対応しないフレームは捨てる（このプロトコルでは非同期通知は来ない）
        if (p) p.resolve(frame);
      }
    });

    socket.on(opts.tls ? "secureConnect" : "connect", () => {
      connected = true;
      resolve({
        request(frame) {
          return new Promise<Uint8Array>((res, rej) => {
            if (pending) {
              rej(new As400Error("PROTOCOL_ERROR", "a host server request is already in flight"));
              return;
            }
            pending = { resolve: res, reject: rej };
            socket.write(Buffer.from(frame));
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

/**
 * ポートマッパー（既定 449）にサービス名を送り、生の応答（5 バイト）を得る。
 * 応答の解釈は `hostserver/port-mapper.ts` が行う（I/O と解釈を分ける）。
 *
 * ポートマッパーは 1 リクエストにつき 1 ソケットしか扱わないため使い捨てる。
 */
export function queryPortMapper(
  host: string,
  serviceName: string,
  port: number,
  timeoutMs: number,
  responseLen: number
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let buffer = Buffer.alloc(0);
    const socket = netConnect({ host, port });
    socket.setTimeout(timeoutMs);

    const finish = (err?: Error, value?: Uint8Array): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (err) reject(err);
      else resolve(value as Uint8Array);
    };

    socket.on("connect", () => socket.write(Buffer.from(serviceName, "latin1")));
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length >= responseLen) finish(undefined, new Uint8Array(buffer));
    });
    socket.on("end", () => {
      if (buffer.length < responseLen) {
        finish(
          new As400Error(
            "PROTOCOL_ERROR",
            `port mapper closed the connection after ${buffer.length} bytes (service "${serviceName}")`
          )
        );
      }
    });
    socket.on("timeout", () =>
      finish(
        new As400Error(
          "CONNECT_FAILED",
          withSocketHint(`port mapper timed out after ${timeoutMs}ms (${host}:${port})`, "ETIMEDOUT")
        )
      )
    );
    socket.on("error", (err) =>
      finish(
        new As400Error("CONNECT_FAILED", `cannot reach port mapper at ${host}:${port}: ${err.message}`, {
          cause: err
        })
      )
    );
  });
}
