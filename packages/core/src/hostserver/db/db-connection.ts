/**
 * database ホストサーバーへの接続。
 *
 * 手順:
 *   1. signon サーバーへ接続してパスワードレベルを得る（用が済んだら閉じる）
 *   2. database サーバー（0xE004）へ接続し `0x7001`→`0x7002` で認証する
 *   3. RPB（要求パラメータブロック）を 1 つ作る
 *
 * 参照: JTOpen(jtopenlite) の DatabaseConnection.getConnection /
 *       createRequestParameterBlock に対応する。
 */
import { As400Error } from "../../errors.js";
import { childLog } from "../../log.js";
import { traced } from "../frame-trace.js";
import {
  openHostConnection,
  type HostConnection,
  type HostTlsOptions
} from "../../transport/host-connection.js";
import { buildRequest, parseReply, type Reply } from "../datastream.js";
import { DEFAULT_PORT, resolveServicePort } from "../port-mapper.js";
import { signon } from "../signon.js";
import { startHostServer } from "../server-connect.js";
import {
  DB_SERVER_ID,
  DB_TEMPLATE_LEN,
  DB_REQ,
  DB_CP,
  ORS,
  buildDbTemplate,
  parseDbTemplate,
  isDbTemplateError
} from "./db-datastream.js";

const log = childLog({ component: "hostserver-db" });

/** 本実装が使う RPB ハンドル。1 接続 1 RPB で足りる */
export const RPB_HANDLE = 1;

/**
 * 日付書式 ISO（yyyy-mm-dd）。実機で 3=*YMD(26-07-18) / 4=*USA(07/18/2026) /
 * 5=*ISO(2026-07-18) / 6=*EUR(18.07.2026) を確認して決めた。
 *
 * **指定しないとジョブの既定になり、年が 2 桁で返って世紀が失われる。**
 */
const DATE_FORMAT_ISO = 5;
/** 時刻書式 ISO（hh.mm.ss） */
const TIME_FORMAT_ISO = 1;

export interface DbConnectOptions {
  host: string;
  user: string;
  password: string;
  /** 明示ポート。未指定なら resolvePort か既定ポート */
  port?: number;
  tls?: boolean | HostTlsOptions;
  /** true でポートマッパー(449)に問い合わせる。既定 false */
  resolvePort?: boolean;
  timeoutMs?: number;
}

/** database サーバーとの接続。要求の往復と RPB を持つ */
export class DbConnection {
  private closed = false;
  private busy = false;

  private constructor(
    private readonly conn: HostConnection,
    readonly host: string,
    readonly port: number
  ) {}

  static async connect(opts: DbConnectOptions): Promise<DbConnection> {
    const timeoutMs = opts.timeoutMs ?? 20_000;

    // 1) パスワードレベルは signon サーバーからしか得られない。取得したら閉じる
    const info = await signon({
      host: opts.host,
      user: opts.user,
      password: opts.password,
      ...(opts.tls !== undefined ? { tls: opts.tls } : {}),
      ...(opts.resolvePort !== undefined ? { resolvePort: opts.resolvePort } : {}),
      timeoutMs
    });

    // 2) database サーバーへ
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
      await startHostServer(conn, DB_SERVER_ID, {
        user: opts.user,
        password: opts.password,
        passwordLevel: info.info.passwordLevel
      });
      const db = new DbConnection(conn, opts.host, port);
      // 3) 日付・時刻の書式を固定する（受け取り側で書式を推測しないため）
      await db.setServerAttributes();
      // 4) RPB を作る（以降の要求はこのハンドルを指す）
      await db.createRpb();
      log.debug(`database server ready at ${opts.host}:${port} (rpb=${RPB_HANDLE})`);
      return db;
    } catch (e) {
      conn.close();
      throw e;
    }
  }

  /**
   * 要求を送り、応答を返す。template のエラーはここで例外にする
   * （SQL 固有のエラーは SQLCA パラメータに載るため呼び出し側で解釈する）。
   */
  async request(opts: {
    reqId: number;
    orsBitmap?: number;
    params: { cp: number; value: Uint8Array }[];
    /** template のエラーを呼び出し側で扱う場合に true */
    allowTemplateError?: boolean;
  }): Promise<Reply> {
    if (this.closed) {
      throw new As400Error("SESSION_CLOSED", "database connection is closed");
    }
    const template = buildDbTemplate({
      orsBitmap: opts.orsBitmap ?? ORS.sendReplyImmediately,
      rpbHandle: RPB_HANDLE,
      parameterCount: opts.params.length
    });
    const frame = buildRequest({
      serverId: DB_SERVER_ID,
      reqRep: opts.reqId,
      template,
      params: opts.params
    });
    const response = await this.conn.request(frame);

    const tmpl = parseDbTemplate(response);
    if (isDbTemplateError(tmpl) && !opts.allowTemplateError) {
      throw new As400Error(
        "PROTOCOL_ERROR",
        `database request 0x${opts.reqId.toString(16)} failed ` +
          `(rcClass=${tmpl.rcClass}, code=${tmpl.rcClassReturnCode})`
      );
    }
    return parseReply(response);
  }


  /**
   * 日付・時刻の書式を ISO に固定する。
   *
   * 値は書式化済みの文字列として行バッファに入るため、**書式が分からないと解釈できない**。
   * ジョブの既定に任せると年が 2 桁になり世紀が失われるので、接続時に明示する。
   */
  private async setServerAttributes(): Promise<void> {
    await this.request({
      reqId: DB_REQ.setServerAttributes,
      params: [
        uint16Param(DB_CP.serverDateFormat, DATE_FORMAT_ISO),
        uint16Param(DB_CP.serverTimeFormat, TIME_FORMAT_ISO)
      ]
    });
  }

  /**
   * RPB を作る。接続ごとに 1 回。
   * **作る RPB のハンドルは template の RPB ハンドル欄で指定する**（パラメータではない）。
   */
  private async createRpb(): Promise<void> {
    await this.request({ reqId: DB_REQ.createRpb, params: [] });
  }

  /**
   * 問い合わせの実行区間を占有する。
   *
   * 文名・カーソル名は接続ごとに固定なので、**同じ接続で問い合わせを重ねると踏み合う**。
   * とくに逐次取得は行の合間に制御を返すため、消費側が反復の途中で別の問い合わせを
   * 開始できてしまう。ここで明示的に弾いて、静かにデータが混ざるのを防ぐ。
   */
  acquire(): () => void {
    if (this.busy) {
      throw new As400Error(
        "PROTOCOL_ERROR",
        "another query is in progress on this connection (open a second connection to run queries concurrently)"
      );
    }
    this.busy = true;
    return () => {
      this.busy = false;
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.conn.close();
  }

  get isClosed(): boolean {
    return this.closed;
  }
}

function uint16Param(cp: number, value: number): { cp: number; value: Uint8Array } {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, value);
  return { cp, value: b };
}

async function decidePort(opts: DbConnectOptions, timeoutMs: number): Promise<number> {
  if (opts.port !== undefined) {
    if (!Number.isInteger(opts.port) || opts.port <= 0 || opts.port > 65535) {
      throw new As400Error("CONFIG_ERROR", `invalid port: ${opts.port}`);
    }
    return opts.port;
  }
  if (opts.resolvePort) {
    // TLS では "-s" 付きのサービス名で問い合わせないと平文ポートが返る
    return resolveServicePort(opts.host, "database", { timeoutMs, tls: Boolean(opts.tls) });
  }
  return opts.tls ? DEFAULT_PORT.database.tls : DEFAULT_PORT.database.plain;
}

export { DB_TEMPLATE_LEN };
