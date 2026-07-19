/**
 * signon 以外のホストサーバー（database / command / file / DDM）を開始する手順。
 *
 * signon が `0x7003`（交換属性）→ `0x7004`（認証）なのに対し、こちらは
 * **`0x7001`（乱数シード交換）→ `0x7002`（サーバー開始）**。
 * パスワード置換値と資格情報のバイト化は signon と**完全に同一**なので、
 * `password.ts` / `credentials.ts` をそのまま再利用する。
 *
 * パスワードレベルは signon サーバーからしか得られないため、
 * 呼び出し側が先に `signon()` で取得して渡す。
 *
 * 参照: JTOpen(jtopenlite) の HostServerConnection.connect /
 *       sendExchangeRandomSeedsRequest / sendStartServerRequest に対応する。
 */
import { As400Error } from "../errors.js";
import { childLog } from "../log.js";
import type { HostConnection } from "../transport/host-connection.js";
import { CP, HEADER_LEN } from "./datastream.js";
import { userIdEbcdic37, userIdUnicode, passwordUnicode } from "./credentials.js";
import {
  generateClientSeed,
  passwordSubstituteSha,
  assertPasswordLevelSupported,
  SEED_LEN
} from "./password.js";

const log = childLog({ component: "hostserver-start" });

const REQ_EXCHANGE_SEEDS = 0x7001;
const REQ_START_SERVER = 0x7002;
/** クライアント属性。1 = SHA-1 に対応している */
const CLIENT_ATTR_SHA1 = 1;
/** クライアント属性。2 = ジョブ情報を返してほしい */
const CLIENT_ATTR_RETURN_JOB_INFO = 2;
const ENCRYPTION_TYPE_DES = 1;
const ENCRYPTION_TYPE_SHA = 3;

/**
 * `0x7001` 要求。
 *
 * ヘッダーが標準形と違う——Header ID の位置に**クライアント属性とサーバー属性**が入る。
 */
function buildExchangeSeedsRequest(serverId: number, clientSeed: Uint8Array): Uint8Array {
  const out = new Uint8Array(28);
  const v = new DataView(out.buffer);
  v.setUint32(0, 28);
  v.setUint8(4, CLIENT_ATTR_SHA1);
  v.setUint8(5, 0); // サーバー属性
  v.setUint16(6, serverId);
  v.setUint32(8, 0); // CS instance
  v.setUint32(12, 0); // Correlation ID
  v.setUint16(16, 8); // template 長（= clientSeed の 8 バイト）
  v.setUint16(18, REQ_EXCHANGE_SEEDS);
  out.set(clientSeed, HEADER_LEN);
  return out;
}

/** `0x7002` 要求 */
function buildStartServerRequest(
  serverId: number,
  userEbcdic: Uint8Array,
  substitute: Uint8Array
): Uint8Array {
  const total = 44 + substitute.length;
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  v.setUint32(0, total);
  v.setUint8(4, CLIENT_ATTR_RETURN_JOB_INFO);
  v.setUint8(5, 0);
  v.setUint16(6, serverId);
  v.setUint32(8, 0);
  v.setUint32(12, 0);
  v.setUint16(16, 2); // template 長（暗号化種別 + 応答要否）
  v.setUint16(18, REQ_START_SERVER);
  v.setUint8(20, substitute.length === 8 ? ENCRYPTION_TYPE_DES : ENCRYPTION_TYPE_SHA);
  v.setUint8(21, 1); // 応答を返す
  let pos = 22;
  v.setUint32(pos, 6 + substitute.length);
  v.setUint16(pos + 4, CP.password);
  out.set(substitute, pos + 6);
  pos += 6 + substitute.length;
  v.setUint32(pos, 16);
  v.setUint16(pos + 4, CP.userId);
  out.set(userEbcdic, pos + 6);
  return out;
}

/** 応答の戻りコード（オフセット 20 の 4 バイト）を読む */
function replyReturnCode(frame: Uint8Array, what: string): number {
  if (frame.length < HEADER_LEN + 4) {
    throw new As400Error("PROTOCOL_ERROR", `${what} reply too short: ${frame.length} bytes`);
  }
  return new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(HEADER_LEN);
}

export interface StartServerOptions {
  user: string;
  password: string;
  /** signon サーバーから取得したパスワードレベル */
  passwordLevel: number;
}

/**
 * ホストサーバーを開始する（認証込み）。
 *
 * @param serverId データストリーム上のサーバー ID（database は 0xE004）
 */
export async function startHostServer(
  conn: HostConnection,
  serverId: number,
  opts: StartServerOptions
): Promise<void> {
  assertPasswordLevelSupported(opts.passwordLevel);

  // --- 0x7001 乱数シード交換 ---
  const clientSeed = generateClientSeed();
  const seedReply = await conn.request(buildExchangeSeedsRequest(serverId, clientSeed));
  const seedRc = replyReturnCode(seedReply, "exchange random seeds");
  if (seedRc !== 0) {
    throw new As400Error(
      "PROTOCOL_ERROR",
      `exchange random seeds failed for server 0x${serverId.toString(16)} ` +
        `(rc=0x${seedRc.toString(16).padStart(8, "0")})`
    );
  }
  // サーバー seed は LL/CP ではなく戻りコードの直後に生で 8 バイト置かれる
  const seedAt = HEADER_LEN + 4;
  if (seedReply.length < seedAt + SEED_LEN) {
    throw new As400Error(
      "PROTOCOL_ERROR",
      `exchange random seeds reply has no ${SEED_LEN}-byte server seed`
    );
  }
  const serverSeed = seedReply.subarray(seedAt, seedAt + SEED_LEN);

  // --- 0x7002 サーバー開始（認証） ---
  const substitute = await passwordSubstituteSha(
    userIdUnicode(opts.user),
    passwordUnicode(opts.password),
    clientSeed,
    serverSeed
  );
  const startReply = await conn.request(
    // レベル 2 以上でも、要求に載せるユーザー ID は CCSID 37（signon と同じ）
    buildStartServerRequest(serverId, userIdEbcdic37(opts.user), substitute)
  );
  const startRc = replyReturnCode(startReply, "start server");
  if (startRc !== 0) {
    throw new As400Error(
      "UNAUTHENTICATED",
      `failed to start host server 0x${serverId.toString(16)} ` +
        `(rc=0x${startRc.toString(16).padStart(8, "0")})`
    );
  }
  log.debug(`host server 0x${serverId.toString(16)} started`);
}
