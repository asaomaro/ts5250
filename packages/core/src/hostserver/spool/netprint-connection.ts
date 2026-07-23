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
import { As400Error } from "../../errors.js";
import { childLog } from "../../log.js";
import { traced } from "../frame-trace.js";
import { ScsDecoder, type LogicalPage } from "../../protocol/scs.js";
import { codecForCcsid } from "../../codec/codec.js";
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
  buildAttributeIdList,
  parseAttributeList,
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

/** メッセージ ID・テキストは CCSID 37 の EBCDIC */
const MESSAGE_CCSID = 37;

/**
 * 1 つのスプールから読み取る上限バイト数。
 *
 * サーバーが終端を返さない異常時に無限ループへ入らないための歯止め。
 * 一覧側には件数上限があるのに読み取り側に無いのは非対称なので設ける。
 */
const MAX_SPOOL_BYTES = 64 * 1024 * 1024;

/** スプールに付いたメッセージ（MSGW の中身） */
export interface SpoolMessage {
  /** 例 "CPA3394" */
  id: string;
  text: string;
  help: string;
  /** 応答に使うハンドル。取得できない場合は応答できない */
  handle?: Uint8Array;
}

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
    const rawConn = await openHostConnection({
      host: opts.host,
      port,
      ...(opts.tls !== undefined ? { tls: opts.tls } : {}),
      timeoutMs
    });
    // **接続を 1 度包む**——request() の呼び出しごとに書くと 1 箇所の書き忘れが穴になる
    const conn = traced(rawConn, log);
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
      throw new As400Error(
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
          throw new As400Error(
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

  /**
   * スプールに付いているメッセージを取得する（MSGW の検出）。
   *
   * 状態が `MESSAGE_WAIT` のスプールは、応答待ちのメッセージを持つ。
   * メッセージが無い場合は undefined を返す（`RET_SPLF_NO_MESSAGE`）。
   *
   * ---
   * **⚠ 実際の MSGW に対しては未検証。**
   *
   * 開発環境（PUB400）では writer を常駐させられず、MSGW 状態を作れなかった
   * （特殊権限が `*NONE`、`STRPRTWTR` が `CPF3464` で弾かれる）。
   * 「メッセージが無い」経路は実機で確認済みで、要求/応答のバイト構成は妥当だが、
   * **メッセージが有る場合に期待どおり解析できるかは確かめられていない**。
   * 権限のある環境で最初に使うときは、結果を検証してから頼ること。
   */
  async retrieveMessage(id: SpoolId): Promise<SpoolMessage | undefined> {
    this.assertOpen();
    const reply = await this.exchange(
      buildNpRequest({
        objectType: NP_OBJECT.spooledFile,
        action: NP_ACTION.retrieveMessage,
        codePoints: [
          { id: NP_CP.spooledFileId, data: this.spoolIdCodePoint(id) },
          {
            id: NP_CP.attributeList,
            data: buildAttributeIdList([
              NP_ATTR.messageId,
              NP_ATTR.messageText,
              NP_ATTR.messageHelp,
              NP_ATTR.messageType,
              NP_ATTR.messageReply
            ])
          }
        ]
      }),
      `retrieve message for ${id.fileName}#${id.fileNumber}`,
      [NP_RC.ok, NP_RC.spooledFileNoMessage]
    );
    if (reply.returnCode === NP_RC.spooledFileNoMessage) return undefined;

    const attrs = findCodePoint(reply, NP_CP.attributeValue);
    if (!attrs) return undefined;
    const values = parseAttributeList(attrs);
    const text = (attrId: number): string => decodeNpString(values.get(attrId));

    const handle = findCodePoint(reply, NP_CP.messageHandle);
    return {
      id: text(NP_ATTR.messageId),
      text: text(NP_ATTR.messageText),
      help: text(NP_ATTR.messageHelp),
      /** 応答するときに使う。これが無いと answerMessage できない */
      ...(handle ? { handle } : {})
    };
  }

  /**
   * メッセージに応答する（MSGW の解除）。
   *
   * **`retrieveMessage` が返したハンドルが必要**。権限が足りない場合は失敗する。
   *
   */
  async answerMessage(message: SpoolMessage, reply: string): Promise<void> {
    this.assertOpen();
    if (!message.handle) {
      throw new As400Error(
        "CONFIG_ERROR",
        "cannot answer a message without a handle (retrieveMessage must return one)"
      );
    }
    await this.exchange(
      buildNpRequest({
        objectType: NP_OBJECT.spooledFile,
        action: NP_ACTION.answerMessage,
        codePoints: [
          { id: NP_CP.messageHandle, data: message.handle },
          {
            id: NP_CP.attributeValue,
            // MSGREPLY は **NUL 終端**で送る。固定長の空白詰めだと応答が届かず
            // answerMessage が rc=0x0009 で失敗する（JTOpen も NPAttrString で末尾を 0 にしている）。
            data: buildAttributeList([{ id: NP_ATTR.messageReply, type: "stringz", value: reply }])
          }
        ]
      }),
      `answer message ${message.id}`
    );
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
      throw new As400Error("SESSION_CLOSED", "network print connection is closed");
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

/**
 * NP サーバーの文字列属性をデコードする。
 *
 * **NUL 終端を先に切る。** この属性は C 文字列で返るのに `trimEnd()` は空白しか落とさないため、
 * NUL が値の末尾に残る。残ると `message.id === "CPA3394"` のような比較が必ず外れ、
 * メッセージ種別で分岐する呼び出し側（応答が要るかの判定）が動かない（実機で確認）。
 */
export function decodeNpString(raw: Uint8Array | undefined): string {
  if (!raw) return "";
  const end = raw.indexOf(0);
  const body = end >= 0 ? raw.subarray(0, end) : raw;
  return codecForCcsid(MESSAGE_CCSID).decode(body).trimEnd();
}

async function decidePort(opts: NetPrintConnectOptions, timeoutMs: number): Promise<number> {
  if (opts.port !== undefined) {
    if (!Number.isInteger(opts.port) || opts.port <= 0 || opts.port > 65535) {
      throw new As400Error("CONFIG_ERROR", `invalid port: ${opts.port}`);
    }
    return opts.port;
  }
  if (opts.resolvePort) {
    return resolveServicePort(opts.host, "print", { timeoutMs, tls: Boolean(opts.tls) });
  }
  return opts.tls ? DEFAULT_PORT.print.tls : DEFAULT_PORT.print.plain;
}
