/**
 * データ待ち行列サーバー（QZHQSSRV / as-dtaq, 0xE007）への接続。
 *
 * 接続手順は他のホストサーバーと共通:
 * signon → ポート解決 → startHostServer → 交換属性。
 *
 * 参照: JTOpen の `BaseDataQueueImplRemote`。
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
  DTAQ_SERVER_ID,
  DTAQ_REPLY,
  DTAQ_RC,
  buildExchangeAttributes,
  buildCreate,
  buildDelete,
  buildWrite,
  buildRead,
  buildClear,
  buildRequestAttributes,
  replyId,
  commonReplyRc,
  parseReadReply,
  parseAttributesReply,
  dtaqFailure
} from "./dtaq-datastream.js";
import type {
  CreateOptions,
  DtaqAttributes,
  DtaqEntry,
  ReadOptions
} from "./dtaq-types.js";

const log = childLog({ component: "hostserver-dtaq" });

/**
 * 受信の待機時間（秒）を、その 1 往復の read タイムアウト（ミリ秒）へ写す。
 *
 * ホストサーバーは待機中に何も送らないので、ソケットの read タイムアウト（既定 20 秒）が
 * 先に切ると無限待ち・長い待機が成立しない（research F3）。
 * - `wait < 0`（無限）→ `0`（タイムアウト無効）
 * - `wait >= 0` → `(wait + 猶予) 秒`。猶予はホストが待機ちょうどで「空」を返す前にソケットが切らないため
 */
const WAIT_GRACE_SEC = 10;
function readTimeoutForWait(wait: number): number {
  if (wait < 0) return 0;
  return (wait + WAIT_GRACE_SEC) * 1000;
}

export interface DtaqConnectOptions {
  host: string;
  user: string;
  password: string;
  port?: number;
  tls?: boolean | HostTlsOptions;
  resolvePort?: boolean;
  timeoutMs?: number;
}

export class DtaqConnection {
  private closed = false;

  private constructor(
    private readonly conn: HostConnection,
    readonly host: string,
    readonly port: number
  ) {}

  static async connect(opts: DtaqConnectOptions): Promise<DtaqConnection> {
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
    const conn = traced(rawConn, log);
    try {
      await startHostServer(conn, DTAQ_SERVER_ID, {
        user: opts.user,
        password: opts.password,
        passwordLevel: signonInfo.info.passwordLevel
      });
      // 交換属性は接続手順に組み込む（送らないと以降の要求が通らない）
      const reply = await conn.request(buildExchangeAttributes());
      if (replyId(reply) !== DTAQ_REPLY.exchangeAttributes) {
        throw dtaqFailure("exchange attributes", reply);
      }
      log.debug(`data queue server ready at ${opts.host}:${port}`);
      return new DtaqConnection(conn, opts.host, port);
    } catch (e) {
      conn.close();
      throw e;
    }
  }

  /** データを積む */
  async write(
    name: string,
    library: string,
    entry: Uint8Array,
    key?: Uint8Array
  ): Promise<void> {
    this.assertOpen();
    assertSuccess("write", await this.conn.request(buildWrite(name, library, entry, key)));
  }

  /**
   * データを取り出す／覗く。空（またはタイムアウト）なら undefined。
   *
   * 待機時間に応じて**この往復だけ** read タイムアウトを変える（無限待ち・長い待機のため）。
   * 応答レイアウトは実機で確定済み（research F2）。
   */
  async read(opts: ReadOptions): Promise<DtaqEntry | undefined> {
    this.assertOpen();
    const reply = await this.conn.request(buildRead(opts), {
      readTimeoutMs: readTimeoutForWait(opts.wait)
    });
    const id = replyId(reply);
    if (id === DTAQ_REPLY.common) {
      if (commonReplyRc(reply) === DTAQ_RC.noData) return undefined; // 空／タイムアウト
      throw dtaqFailure("read", reply);
    }
    if (id !== DTAQ_REPLY.read) {
      throw new As400Error("PROTOCOL_ERROR", `unexpected dtaq read reply 0x${id.toString(16)}`);
    }
    return parseReadReply(reply);
  }

  async create(opts: CreateOptions): Promise<void> {
    this.assertOpen();
    assertSuccess("create", await this.conn.request(buildCreate(opts)));
  }

  async deleteQueue(name: string, library: string): Promise<void> {
    this.assertOpen();
    assertSuccess("delete", await this.conn.request(buildDelete(name, library)));
  }

  async clear(name: string, library: string, key?: Uint8Array): Promise<void> {
    this.assertOpen();
    assertSuccess("clear", await this.conn.request(buildClear(name, library, key)));
  }

  /** キューの属性を取得する */
  async attributes(name: string, library: string): Promise<DtaqAttributes> {
    this.assertOpen();
    const reply = await this.conn.request(buildRequestAttributes(name, library));
    const id = replyId(reply);
    if (id !== DTAQ_REPLY.requestAttributes) {
      // 共通応答（0x8002）ならエラー。それ以外は想定外
      throw dtaqFailure("attributes", reply);
    }
    return parseAttributesReply(reply);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.conn.close();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private assertOpen(): void {
    if (this.closed) throw new As400Error("SESSION_CLOSED", "data queue connection is closed");
  }
}

/** 成功（共通応答 0x8002 rc=0xF000）でなければ、区別できるエラーを投げる */
function assertSuccess(what: string, reply: Uint8Array): void {
  const id = replyId(reply);
  if (id === DTAQ_REPLY.common && commonReplyRc(reply) === DTAQ_RC.success) return;
  throw dtaqFailure(what, reply);
}

async function decidePort(opts: DtaqConnectOptions, timeoutMs: number): Promise<number> {
  if (opts.port !== undefined) {
    if (!Number.isInteger(opts.port) || opts.port <= 0 || opts.port > 65535) {
      throw new As400Error("CONFIG_ERROR", `invalid port: ${opts.port}`);
    }
    return opts.port;
  }
  if (opts.resolvePort) {
    return resolveServicePort(opts.host, "dataQueue", { timeoutMs, tls: Boolean(opts.tls) });
  }
  return opts.tls ? DEFAULT_PORT.dataQueue.tls : DEFAULT_PORT.dataQueue.plain;
}
