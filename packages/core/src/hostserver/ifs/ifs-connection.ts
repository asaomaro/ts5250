/**
 * IFS（統合ファイルシステム）のファイル読み書き。
 *
 * ファイルサーバー（QZLSFILE / 8473・9473）へ接続し、
 * **交換属性 → OPEN → READ/WRITE → CLOSE** の手順でファイルを扱う。
 *
 * 参照: JTOpen(jtopenlite) の FileConnection / FileHandle に対応する。
 */
import { As400Error } from "../../errors.js";
import { childLog } from "../../log.js";
import { traced } from "../frame-trace.js";
import {
  openHostConnection,
  type HostConnection,
  type HostTlsOptions
} from "../../transport/host-connection.js";
import { DEFAULT_PORT, resolveServicePort } from "../port-mapper.js";
import { signon } from "../signon.js";
import { startHostServer } from "../server-connect.js";
import {
  FILE_SERVER_ID,
  FILE_ACCESS,
  buildFileExchangeAttributes,
  buildOpenFileRequest,
  buildReadRequest,
  buildWriteRequest,
  buildCloseRequest,
  buildDeleteRequest,
  replyReturnCode,
  replyFileHandle,
  fileErrorText,
  readReplyData
} from "./ifs-datastream.js";

const log = childLog({ component: "hostserver-ifs" });

/** 1 回の読み書きで扱う既定のバイト数 */
const DEFAULT_CHUNK = 32768;
/** 1 ファイルの上限。終端が返らない異常時の歯止め */
const MAX_FILE_BYTES = 256 * 1024 * 1024;

export interface IfsConnectOptions {
  host: string;
  user: string;
  password: string;
  port?: number;
  tls?: boolean | HostTlsOptions;
  resolvePort?: boolean;
  timeoutMs?: number;
}

export class IfsConnection {
  private closed = false;

  private constructor(
    private readonly conn: HostConnection,
    readonly host: string,
    readonly port: number
  ) {}

  static async connect(opts: IfsConnectOptions): Promise<IfsConnection> {
    const timeoutMs = opts.timeoutMs ?? 20_000;
    const signonInfo = await signon({
      host: opts.host,
      user: opts.user,
      password: opts.password,
      ...(opts.tls !== undefined ? { tls: opts.tls } : {}),
      ...(opts.resolvePort !== undefined ? { resolvePort: opts.resolvePort } : {}),
      timeoutMs
    });

    const port = await decidePort(opts, timeoutMs);
    const rawConn = await openHostConnection({
      host: opts.host,
      port,
      ...(opts.tls !== undefined ? { tls: opts.tls } : {}),
      timeoutMs
    });
    // **接続を 1 度包む**——request() の呼び出しごとに書くと 1 箇所の書き忘れが穴になる
    const conn = traced(rawConn, log);
    try {
      await startHostServer(conn, FILE_SERVER_ID, {
        user: opts.user,
        password: opts.password,
        passwordLevel: signonInfo.info.passwordLevel
      });
      // 交換属性は接続手順に組み込む（送らないと以降の要求が通らない）
      const rc = replyReturnCode(await conn.request(buildFileExchangeAttributes()));
      if (rc !== 0) {
        throw new As400Error(
          "PROTOCOL_ERROR",
          `file server exchange attributes failed (rc=0x${rc.toString(16)})`
        );
      }
      log.debug(`file server ready at ${opts.host}:${port}`);
      return new IfsConnection(conn, opts.host, port);
    } catch (e) {
      conn.close();
      throw e;
    }
  }

  /** ファイルを読む */
  async readFile(path: string): Promise<Uint8Array> {
    this.assertOpen();
    const handle = await this.open(path, FILE_ACCESS.read, false);
    const chunks: Uint8Array[] = [];
    let offset = 0;
    try {
      for (;;) {
        const reply = await this.conn.request(buildReadRequest(handle, offset, DEFAULT_CHUNK));
        // 読み終わりはエラー応答で返る。例外にしない
        if (replyReturnCode(reply) !== 0) break;
        const data = readReplyData(reply);
        if (!data || data.length === 0) break;
        chunks.push(new Uint8Array(data));
        offset += data.length;
        if (offset > MAX_FILE_BYTES) {
          throw new As400Error(
            "PROTOCOL_ERROR",
            `file exceeded ${MAX_FILE_BYTES} bytes without reaching end (${path})`
          );
        }
        if (data.length < DEFAULT_CHUNK) break;
      }
    } finally {
      await this.closeQuietly(handle);
    }
    return concat(chunks);
  }

  /** ファイルを書く（既定で無ければ作る） */
  async writeFile(path: string, data: Uint8Array, opts: { create?: boolean } = {}): Promise<void> {
    this.assertOpen();
    const handle = await this.open(path, FILE_ACCESS.write, opts.create ?? true);
    try {
      let offset = 0;
      while (offset < data.length) {
        const slice = data.subarray(offset, offset + DEFAULT_CHUNK);
        const rc = replyReturnCode(await this.conn.request(buildWriteRequest(handle, offset, slice)));
        if (rc !== 0) {
          throw new As400Error(
            "PROTOCOL_ERROR",
            `failed to write ${path} at offset ${offset}: ${fileErrorText(rc)} (rc=${rc})`
          );
        }
        offset += slice.length;
      }
    } finally {
      await this.closeQuietly(handle);
    }
  }

  /** ファイルを削除する */
  async deleteFile(path: string): Promise<void> {
    this.assertOpen();
    const rc = replyReturnCode(await this.conn.request(buildDeleteRequest(path)));
    if (rc !== 0) {
      throw new As400Error(
        "PROTOCOL_ERROR",
        `failed to delete ${path}: ${fileErrorText(rc)} (rc=${rc})`
      );
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.conn.close();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private async open(path: string, access: number, create: boolean): Promise<number> {
    const reply = await this.conn.request(buildOpenFileRequest({ path, access, create }));
    const rc = replyReturnCode(reply);
    if (rc !== 0) {
      throw new As400Error(
        "PROTOCOL_ERROR",
        `failed to open ${path}: ${fileErrorText(rc)} (rc=${rc})`
      );
    }
    return replyFileHandle(reply);
  }

  /** 片付けの失敗で結果を捨てない */
  private async closeQuietly(handle: number): Promise<void> {
    try {
      await this.conn.request(buildCloseRequest(handle));
    } catch (e) {
      log.debug(`close file handle ${handle} failed: ${String(e)}`);
    }
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new As400Error("SESSION_CLOSED", "IFS connection is closed");
    }
  }
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

async function decidePort(opts: IfsConnectOptions, timeoutMs: number): Promise<number> {
  if (opts.port !== undefined) {
    if (!Number.isInteger(opts.port) || opts.port <= 0 || opts.port > 65535) {
      throw new As400Error("CONFIG_ERROR", `invalid port: ${opts.port}`);
    }
    return opts.port;
  }
  if (opts.resolvePort) {
    return resolveServicePort(opts.host, "file", { timeoutMs, tls: Boolean(opts.tls) });
  }
  return opts.tls ? DEFAULT_PORT.file.tls : DEFAULT_PORT.file.plain;
}
