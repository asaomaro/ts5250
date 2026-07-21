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

/** 1 往復ぶんの読み取りタイムアウトを上書きするオプション */
export interface RequestOptions {
  /**
   * **この 1 往復だけ**の read タイムアウト（ミリ秒）。省略時は接続既定（`timeoutMs`）のまま。
   * `0` を渡すとタイムアウトを無効化する（データ待ち行列の無限待ち `wait=-1` 用）。
   * 応答受信・失敗のいずれでも既定値に戻すので、次の要求は従来どおり。
   */
  readTimeoutMs?: number;
}

/** 1 往復ずつフレームをやり取りする接続 */
export interface HostConnection {
  /**
   * フレームを送り、対応する応答フレームを返す。
   *
   * `opts.readTimeoutMs` を渡すと**その往復だけ**ソケットの read タイムアウトを変える
   * （無限待ちや長い待機のため）。**省略時は接続を一切いじらない**ので、
   * 既存の全呼び出し（signon/SQL/IFS/command）は従来どおり `timeoutMs` で動く。
   */
  request(frame: Uint8Array, opts?: RequestOptions): Promise<Uint8Array>;
  /**
   * フレームを送り、**連鎖して返る複数の応答**を順に `onFrame` へ渡す。
   *
   * listFiles（0x000A）のように 1 エントリ = 1 応答フレームで返る要求のためのもの。
   * `request()` は 1 フレーム目だけを resolve して残りを捨ててしまう。
   *
   * **`onFrame` が `false` を返してよいのは、いま渡されたフレームがプロトコル上の終端**
   * （listFiles なら 0x8001）**のときだけ**。まだ続きが飛んでくる状態で `false` を返すと、
   * 残りのフレームが次の要求の応答として読まれ、以降すべてが 1 つずつずれる。
   * 件数を絞りたいときは受信側で打ち切らず、**要求側の maxCount** を使うこと。
   *
   * `onFrame` が例外を投げた場合、連鎖の途中で抜けたことになり残量が分からないため、
   * **この接続は以後使えなくなる**（次の要求は即座に失敗する）。呼び出し側は接続を閉じること。
   */
  requestStream(frame: Uint8Array, onFrame: (frame: Uint8Array) => boolean): Promise<void>;
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
    /**
     * 実行中の要求。`onFrame` があるものは連鎖応答を受け取る要求で、
     * `onFrame` が false を返すまで pending を保持し続ける。
     */
    type Pending = {
      resolve(f: Uint8Array): void;
      reject(e: Error): void;
      onFrame?: (f: Uint8Array) => boolean;
    };
    let pending: Pending | undefined;
    let connected = false;
    /** 連鎖の途中で抜けて、以後フレームの対応が信用できなくなった状態 */
    let desynced = false;

    const fail = (err: Error): void => {
      const p = pending;
      pending = undefined;
      if (p) {
        // **実行中の要求を諦めた時点で、その応答はまだ飛んでくるかもしれない。**
        // 遅れて届いた応答を次の要求のものとして読むと、以降すべてが 1 つずれる。
        // 「届いてから気づく」のでは、先に次の要求を出された場合に間に合わない——
        // 諦めた瞬間に確定させる
        desynced = true;
        p.reject(err);
      } else if (!connected) reject(err);
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
        // **このプロトコルに非同期通知は無い**（このファイル冒頭の前提）。
        // つまり対応する要求の無いフレームが届いた時点で、それ自体がずれの証拠。
        // 以前はここで黙って捨てており、次の要求がこの残骸を応答として読む余地があった
        if (!p) {
          desynced = true;
          continue;
        }
        if (!p.onFrame) {
          pending = undefined;
          p.resolve(frame);
          continue;
        }
        // 連鎖応答: onFrame が false を返すまで pending を保持して受け続ける
        let more: boolean;
        try {
          more = p.onFrame(frame);
        } catch (e) {
          // 連鎖の途中で抜けた。残り何フレーム飛んでくるか分からないので、
          // この接続で次の要求を出すと**前の連鎖の残骸を応答として読む**。
          // 黙ってずれるより、以後の要求を即座に失敗させる方が原因を追える
          desynced = true;
          pending = undefined;
          p.reject(e instanceof Error ? e : new Error(String(e)));
          return;
        }
        if (!more) {
          pending = undefined;
          p.resolve(frame);
        }
      }
    });

    socket.on(opts.tls ? "secureConnect" : "connect", () => {
      connected = true;
      /**
       * 要求を出せる状態か。連鎖の途中で抜けた接続は、残骸を次の応答として読むため使わせない
       * （黙ってずれると症状が別の場所に出て原因が追えなくなる）。
       */
      const rejectIfUnusable = (rej: (e: Error) => void): boolean => {
        if (desynced) {
          rej(
            new As400Error(
              "PROTOCOL_ERROR",
              "this host server connection was abandoned mid-chain and can no longer be used"
            )
          );
          return true;
        }
        if (pending) {
          rej(new As400Error("PROTOCOL_ERROR", "a host server request is already in flight"));
          return true;
        }
        return false;
      };
      resolve({
        request(frame, opts) {
          return new Promise<Uint8Array>((res, rej) => {
            if (rejectIfUnusable(rej)) return;
            // この往復だけ read タイムアウトを変える。応答/失敗のどちらでも既定へ戻す
            // （`socket.setTimeout(0)` はタイマー無効化＝無限待ち）
            const override = opts?.readTimeoutMs !== undefined;
            const restore = (): void => {
              if (override) socket.setTimeout(timeoutMs);
            };
            pending = {
              resolve: (f) => {
                restore();
                res(f);
              },
              reject: (e) => {
                restore();
                rej(e);
              }
            };
            if (override) socket.setTimeout(opts.readTimeoutMs as number);
            socket.write(Buffer.from(frame));
          });
        },
        requestStream(frame, onFrame) {
          return new Promise<void>((res, rej) => {
            if (rejectIfUnusable(rej)) return;
            pending = { resolve: () => res(), reject: rej, onFrame };
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
