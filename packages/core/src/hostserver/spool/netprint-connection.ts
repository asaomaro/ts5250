/**
 * ネットワーク印刷サーバー（QNPSERVS / 8474・9474）への接続とスプールの中身取得。
 *
 * 手順: OPEN(0x0002) → READ(0x0003) を繰り返す → CLOSE(0x0005)
 *
 * 参照: JTOpen 本体の NPSystem / PrintObjectInputStreamImplRemote に対応する
 *       （jtopenlite はネットワーク印刷サーバーを実装していない）。
 *
 * 補足: 同じ内容は SQL の `SYSTOOLS.SPOOLED_FILE_DATA` でも取得できる（実機で確認済み）。
 *       本実装はホストサーバー経由で統一する方針のためこちらを採るが、
 *       SQL は**検証時の照合**に使える。
 */
import { Tn5250Error } from "../../errors.js";
import { childLog } from "../../log.js";
import { ScsDecoder, type LogicalPage } from "../../protocol/scs.js";
import {
  openHostConnection,
  type HostConnection,
  type HostTlsOptions
} from "../../transport/host-connection.js";
import { DEFAULT_PORT, resolveServicePort } from "../port-mapper.js";
import { signon } from "../signon.js";
import { startHostServer } from "../server-connect.js";
import {
  NP_SERVER_ID,
  NP_ACTION,
  NP_OBJECT,
  NP_CP,
  NP_ATTR,
  NP_ATTR_LEN,
  buildAttributeList,
  buildNpRequest,
  parseNpReply,
  findCodePoint,
  NP_RC
} from "./netprint-datastream.js";
import type { SpoolId } from "./spool-types.js";

const log = childLog({ component: "hostserver-netprint" });

/**
 * SCS の既定 CCSID。
 *
 * 273 はドイツ語系（PUB400 の既定）。日本語環境では 930 / 939 / 5035 になるため、
 * **接続時に指定できるようにしてある**（既存 `PrinterSession` と同じ扱い）。
 */
const DEFAULT_SCS_CCSID = 273;

/**
 * 1 つのスプールから読み取る上限バイト数。
 *
 * サーバーが終端を返さない異常時に無限ループへ入らないための歯止め。
 * 一覧側には件数上限があるのに読み取り側に無いのは非対称なので設ける。
 */
const MAX_SPOOL_BYTES = 64 * 1024 * 1024;

export interface NetPrintConnectOptions {
  host: string;
  /** SCS の CCSID。既定 273。日本語環境では 930 / 939 / 5035 を指定する */
  ccsid?: number;
  user: string;
  password: string;
  port?: number;
  tls?: boolean | HostTlsOptions;
  resolvePort?: boolean;
  timeoutMs?: number;
}

export class NetPrintConnection {
  private closed = false;

  private constructor(
    private readonly conn: HostConnection,
    readonly host: string,
    readonly port: number,
    /** SCS の解釈に使う CCSID */
    readonly ccsid: number
  ) {}

  static async connect(opts: NetPrintConnectOptions): Promise<NetPrintConnection> {
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
    const conn = await openHostConnection({
      host: opts.host,
      port,
      ...(opts.tls !== undefined ? { tls: opts.tls } : {}),
      timeoutMs
    });
    try {
      await startHostServer(conn, NP_SERVER_ID, {
        user: opts.user,
        password: opts.password,
        passwordLevel: signonInfo.info.passwordLevel
      });
      log.debug(`network print server ready at ${opts.host}:${port}`);
      return new NetPrintConnection(conn, opts.host, port, opts.ccsid ?? DEFAULT_SCS_CCSID);
    } catch (e) {
      conn.close();
      throw e;
    }
  }

  /** スプールを指すコードポイント（属性の集まり） */
  private spoolIdCodePoint(id: SpoolId): Uint8Array {
    return buildAttributeList([
      {
        id: NP_ATTR.spooledFileName,
        type: "string",
        value: id.fileName,
        length: NP_ATTR_LEN.spooledFileName
      },
      { id: NP_ATTR.spooledFileNumber, type: "int", value: id.fileNumber },
      { id: NP_ATTR.jobName, type: "string", value: id.jobName, length: NP_ATTR_LEN.jobName },
      { id: NP_ATTR.jobUser, type: "string", value: id.jobUser, length: NP_ATTR_LEN.jobUser },
      { id: NP_ATTR.jobNumber, type: "string", value: id.jobNumber, length: NP_ATTR_LEN.jobNumber }
    ]);
  }

  /**
   * 1 往復。許容する戻りコード以外なら例外にする。
   * READ の終端（`readEof`）はエラーではないため、呼び出し側で許容できるようにする。
   */
  private async exchange(
    frame: Uint8Array,
    what: string,
    allowed: readonly number[] = [NP_RC.ok]
  ): Promise<ReturnType<typeof parseNpReply>> {
    const reply = parseNpReply(await this.conn.request(frame));
    if (!allowed.includes(reply.returnCode)) {
      throw new Tn5250Error(
        "PROTOCOL_ERROR",
        `network print ${what} failed (rc=0x${reply.returnCode.toString(16).padStart(4, "0")})`
      );
    }
    return reply;
  }

  /**
   * スプールの生バイト列（SCS）を読む。
   *
   * ネットワーク印刷サーバーが返すのは**印刷用の SCS ストリーム**であって
   * テキストではない。テキストが欲しい場合は `readSpooledPages` を使う。
   *
   * 権限の範囲でしか読めない——他人のスプールは開けない。
   */
  async readSpooledFileRaw(id: SpoolId): Promise<Uint8Array> {
    this.assertOpen();
    const idCp = this.spoolIdCodePoint(id);

    const opened = await this.exchange(
      buildNpRequest({
        objectType: NP_OBJECT.spooledFile,
        action: NP_ACTION.open,
        codePoints: [{ id: NP_CP.spooledFileId, data: idCp }]
      }),
      `open ${id.fileName}#${id.fileNumber}`
    );
    const handle = findCodePoint(opened, NP_CP.spooledFileHandle);

    const buffered: Uint8Array[] = [];
    let total = 0;
    try {
      const chunk = 32768;
      for (;;) {
        const reply = await this.exchange(
          buildNpRequest({
            objectType: NP_OBJECT.spooledFile,
            action: NP_ACTION.read,
            codePoints: [
              ...(handle ? [{ id: NP_CP.spooledFileHandle, data: handle }] : []),
              // 読み取りバイト数を指定しないと RET_RETURN_CP_MISSING(0x19) になる
              {
                id: NP_CP.attributeValue,
                data: buildAttributeList([
                  { id: NP_ATTR.numberOfBytes, type: "int", value: chunk }
                ])
              }
            ]
          }),
          "read",
          [NP_RC.ok, NP_RC.readIncomplete, NP_RC.readEof]
        );
        if (reply.returnCode === NP_RC.readEof) break;
        const data = findCodePoint(reply, NP_CP.data);
        if (!data || data.length === 0) break;
        buffered.push(data);
        total += data.length;
        if (total > MAX_SPOOL_BYTES) {
          throw new Tn5250Error(
            "PROTOCOL_ERROR",
            `spooled file exceeded ${MAX_SPOOL_BYTES} bytes without reaching end of file`
          );
        }
      }
    } finally {
      // 読めた分は捨てない。片付けの失敗で結果を失わせない
      try {
        await this.exchange(
          buildNpRequest({
            objectType: NP_OBJECT.spooledFile,
            action: NP_ACTION.close,
            codePoints: handle ? [{ id: NP_CP.spooledFileHandle, data: handle }] : []
          }),
          "close"
        );
      } catch (e) {
        log.debug(`close spooled file failed: ${String(e)}`);
      }
    }
    return concatBytes(buffered);
  }

  /**
   * スプールを論理ページとして読む。
   *
   * **push 型（`PrinterSession`）と同じ `ScsDecoder` を使う**——
   * 同じ SCS を同じ規則で解釈するため、経路が違っても結果が揃う。
   *
   * @param ccsid SCS の文字コード。既定はサーバーの CCSID に合わせて指定する
   */
  async readSpooledPages(id: SpoolId, opts: { ccsid?: number } = {}): Promise<LogicalPage[]> {
    const raw = await this.readSpooledFileRaw(id);
    return new ScsDecoder(opts.ccsid ?? this.ccsid).decode(raw);
  }

  /** 論理ページを行の配列にする（ページ区切りは失われる） */
  async readSpooledText(id: SpoolId, opts: { ccsid?: number } = {}): Promise<string[]> {
    const pages = await this.readSpooledPages(id, opts);
    return pages.flatMap((p) => p.lines);
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
    if (this.closed) {
      throw new Tn5250Error("SESSION_CLOSED", "network print connection is closed");
    }
  }
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

async function decidePort(opts: NetPrintConnectOptions, timeoutMs: number): Promise<number> {
  if (opts.port !== undefined) {
    if (!Number.isInteger(opts.port) || opts.port <= 0 || opts.port > 65535) {
      throw new Tn5250Error("CONFIG_ERROR", `invalid port: ${opts.port}`);
    }
    return opts.port;
  }
  if (opts.resolvePort) {
    return resolveServicePort(opts.host, "print", { timeoutMs, tls: Boolean(opts.tls) });
  }
  return opts.tls ? DEFAULT_PORT.print.tls : DEFAULT_PORT.print.plain;
}
