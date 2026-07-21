/**
 * signon ホストサーバー（QZSOSIGN）への接続と認証。
 *
 * 手順は 2 往復。
 *   1. 交換属性 (0x7003) — サーバー版数・パスワードレベル・サーバー seed を得る
 *   2. signon 情報 (0x7004) — パスワード置換値を送って認証する
 *
 * 認証部分（パスワード置換値・資格情報のバイト化）は signon 固有ではなく、database 等
 * 他のホストサーバーでもそのまま使える。将来の再利用のため password.ts / credentials.ts に
 * 分けてある（それらのサーバーは 0x7001/0x7002 という別の枠を使うだけ）。
 *
 * 参照: JTOpen(jtopenlite) の SignonConnection に対応する
 *       （コードの移植ではなく、シーケンスに基づく実装）。
 */
import {
  openHostConnection,
  type HostConnection,
  type HostTlsOptions
} from "../transport/host-connection.js";
import { As400Error } from "../errors.js";
import { childLog } from "../log.js";
import { traceFrame } from "./frame-trace.js";
import {
  buildRequest,
  parseReply,
  findParam,
  findUint,
  uintParam,
  CP,
  REQREP,
  SERVER_ID,
  type Reply
} from "./datastream.js";
import {
  userIdEbcdic37,
  userIdUnicode,
  passwordUnicode,
  passwordEbcdic37,
  decodeJobName
} from "./credentials.js";
import {
  generateClientSeed,
  passwordSubstituteSha,
  passwordSubstituteDes,
  MIN_SHA_PASSWORD_LEVEL,
  SEED_LEN
} from "./password.js";
import {
  classifySignonReturnCode,
  describeSignonFailure,
  RC_OK,
  type SignonFailure,
  type SignonFailureKind
} from "./return-codes.js";
import { DEFAULT_PORT, resolveServicePort } from "./port-mapper.js";

const log = childLog({ component: "hostserver-signon" });

/** クライアント側が申告する CCSID。UTF-16BE */
const CLIENT_CCSID = 1200;
/** CP 0x1128（エラーメッセージ返却）を付ける最小データストリームレベル */
const ERROR_MESSAGES_MIN_LEVEL = 5;
/** 置換値が 8 バイトなら DES、それ以外は SHA を表す */
const ENCRYPTION_TYPE_DES = 1;
const ENCRYPTION_TYPE_SHA = 3;

export type HostServerTlsOptions = HostTlsOptions;

export interface SignonOptions {
  host: string;
  user: string;
  password: string;
  /** 明示ポート。未指定なら resolvePort か既定ポート */
  port?: number;
  /** TLS。既定 false。true で証明書検証あり */
  tls?: boolean | HostServerTlsOptions;
  /** true でポートマッパー(449)に問い合わせる。既定 false */
  resolvePort?: boolean;
  timeoutMs?: number;
}

/** 交換属性応答から得られるサーバー情報 */
export interface HostServerInfo {
  /** VRM 表記。例 "V7R5M0" */
  version: string;
  rawVersion: number;
  datastreamLevel: number;
  /** QPWDLVL 相当。2 以上で SHA 経路 */
  passwordLevel: number;
  /** 例 "657007/QUSER/QZSOSIGN" */
  jobName?: string;
}

/**
 * 認証失敗。原因を**型として**公開し、呼び出し側が文言ではなく値で分岐できるようにする。
 */
export class SignonError extends As400Error {
  constructor(readonly failure: SignonFailure) {
    super("UNAUTHENTICATED", describeSignonFailure(failure));
    this.name = "SignonError";
  }
  /** IBM i が返した戻りコード（例 0x0003000b） */
  get rc(): number {
    return this.failure.rc;
  }
  /** 原因の分類 */
  get kind(): SignonFailureKind {
    return this.failure.kind;
  }
  /** 資格情報を直せば通る見込みがあるか */
  get retryable(): boolean {
    return this.failure.retryable;
  }
}

export interface SignonResult {
  info: HostServerInfo;
  /** 応答 CP 0x1114。PUB400 では 273 */
  serverCcsid?: number;
}

/**
 * signon サーバーへ接続して認証する。**成功した場合のみ解決する**。
 *
 * 接続はこの関数の中で完結して閉じる（認証が通ることの確認が目的で、
 * セッションを保持しない）。
 */
export async function signon(opts: SignonOptions): Promise<SignonResult> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const port = await decidePort(opts, timeoutMs);
  const conn = await openHostConnection({
    host: opts.host,
    port,
    ...(opts.tls !== undefined ? { tls: opts.tls } : {}),
    timeoutMs
  });

  try {
    const info = await exchangeAttributes(conn);
    log.debug(
      `signon server ${opts.host}:${port} version=${info.version} dsLevel=${info.datastreamLevel} ` +
        `passwordLevel=${info.passwordLevel} job=${info.jobName ?? "?"}`
    );
    return await authenticate(conn, opts, info);
  } finally {
    conn.close();
  }
}

async function decidePort(opts: SignonOptions, timeoutMs: number): Promise<number> {
  if (opts.port !== undefined) {
    if (!Number.isInteger(opts.port) || opts.port <= 0 || opts.port > 65535) {
      throw new As400Error("CONFIG_ERROR", `invalid port: ${opts.port}`);
    }
    return opts.port;
  }
  if (opts.resolvePort) {
    // TLS では "-s" 付きのサービス名で問い合わせないと平文ポートが返る
    return resolveServicePort(opts.host, "signon", { timeoutMs, tls: Boolean(opts.tls) });
  }
  return opts.tls ? DEFAULT_PORT.signon.tls : DEFAULT_PORT.signon.plain;
}

/** 交換属性 (0x7003) を送り、サーバー情報と seed を得る */
async function exchangeAttributes(
  conn: HostConnection
): Promise<HostServerInfo & { serverSeed: Uint8Array; clientSeed: Uint8Array }> {
  const clientSeed = generateClientSeed();
  const reply = await exchange(conn,
    buildRequest({
      serverId: SERVER_ID.signon,
      reqRep: REQREP.signonExchangeAttributes,
      params: [
        uintParam(CP.version, 1, 4),
        uintParam(CP.datastreamLevel, 2, 2),
        { cp: CP.seed, value: clientSeed }
      ]
    })
  );

  if (reply.returnCode !== RC_OK) {
    throw new As400Error(
      "PROTOCOL_ERROR",
      `signon exchange attributes failed (rc=0x${reply.returnCode.toString(16).padStart(8, "0")})`
    );
  }

  const serverSeed = findParam(reply, CP.seed);
  if (!serverSeed || serverSeed.length !== SEED_LEN) {
    throw new As400Error(
      "PROTOCOL_ERROR",
      `signon server did not return an ${SEED_LEN}-byte seed (got ${serverSeed?.length ?? 0})`
    );
  }
  const passwordLevel = findUint(reply, CP.passwordLevel);
  if (passwordLevel === undefined) {
    throw new As400Error("PROTOCOL_ERROR", "signon server did not report a password level");
  }
  const rawVersion = findUint(reply, CP.version) ?? 0;

  const jobName = decodeJobName(findParam(reply, CP.jobName));
  return {
    version: formatVersion(rawVersion),
    rawVersion,
    datastreamLevel: findUint(reply, CP.datastreamLevel) ?? 0,
    passwordLevel,
    ...(jobName !== undefined ? { jobName } : {}),
    serverSeed,
    clientSeed
  };
}

/** signon 情報 (0x7004) を送って認証する */
async function authenticate(
  conn: HostConnection,
  opts: SignonOptions,
  info: HostServerInfo & { serverSeed: Uint8Array; clientSeed: Uint8Array }
): Promise<SignonResult> {
  // レベル 0/1 は DES（8 バイト置換）、レベル >= 2 は SHA（20 バイト置換）。
  // 要求テンプレートの暗号化種別は substitute の長さで自動的に切り替わる（下）
  const substitute =
    info.passwordLevel < MIN_SHA_PASSWORD_LEVEL
      ? passwordSubstituteDes(
          userIdEbcdic37(opts.user),
          passwordEbcdic37(opts.password),
          info.clientSeed,
          info.serverSeed
        )
      : await passwordSubstituteSha(
          userIdUnicode(opts.user),
          passwordUnicode(opts.password),
          info.clientSeed,
          info.serverSeed
        );

  const params = [
    uintParam(CP.clientCcsid, CLIENT_CCSID, 4),
    { cp: CP.password, value: substitute },
    // レベル 2 以上でも、要求に載せるユーザー ID は CCSID 37（ハッシュ入力とは別形式）
    { cp: CP.userId, value: userIdEbcdic37(opts.user) }
  ];
  if (info.datastreamLevel >= ERROR_MESSAGES_MIN_LEVEL) {
    params.push(uintParam(CP.returnErrorMessages, 1, 1));
  }

  const reply = await exchange(
    conn,
    buildRequest({
      serverId: SERVER_ID.signon,
      reqRep: REQREP.signonInfo,
      template: Uint8Array.from([
        substitute.length === 8 ? ENCRYPTION_TYPE_DES : ENCRYPTION_TYPE_SHA
      ]),
      params
    })
  );

  const failure = classifySignonReturnCode(reply.returnCode);
  if (failure) throw new SignonError(failure);

  const serverCcsid = findUint(reply, CP.serverCcsid);
  const { serverSeed: _s, clientSeed: _c, ...publicInfo } = info;
  return { info: publicInfo, ...(serverCcsid !== undefined ? { serverCcsid } : {}) };
}

/** フレームを送り、応答を解析する。トレースはここで掛ける（パスワードはマスク） */
async function exchange(conn: HostConnection, frame: Uint8Array): Promise<Reply> {
  traceFrame(log, "send", frame);
  const response = await conn.request(frame);
  traceFrame(log, "recv", response);
  return parseReply(response);
}

/**
 * VRM（version / release / modification level）を "V7R5M0" 形式にする。
 * **バージョンは上位 16 ビット**で、単純な 4 バイト分割ではない（0x00070500 → V7R5M0）。
 */
function formatVersion(raw: number): string {
  const version = (raw >>> 16) & 0xffff;
  const release = (raw >>> 8) & 0xff;
  const modification = raw & 0xff;
  return `V${version}R${release}M${modification}`;
}

/** ジョブ名は先頭 4 バイトが CCSID(常に 0)、以降が EBCDIC（資格情報と同じ CCSID 37） */

