/**
 * ネットワーク印刷サーバー（QNPSERVS）のデータストリーム。
 *
 * signon 系と**同じ 20 バイトヘッダー**の後に、**12 バイトのテンプレート**
 * （操作 ID / フラグ / 戻りコード / EO）が付き、その後に LL/CP のコードポイントが並ぶ。
 *
 * 参照: JTOpen 本体の NPDataStream / NPCPAttributeValue / NPCPIDSplF に対応する
 *       （jtopenlite はネットワーク印刷サーバーを実装していない）。
 */
import { Tn5250Error } from "../../errors.js";
import { HEADER_LEN } from "../datastream.js";
import { codecForCcsid } from "../../codec/codec.js";

/** ネットワーク印刷サーバーのサーバー ID */
export const NP_SERVER_ID = 0xe003;
/** テンプレート長（操作 ID 2 ＋ フラグ 4 ＋ 戻りコード 2 ＋ EO 4） */
export const NP_TEMPLATE_LEN = 12;
/** コードポイント列の開始位置 */
export const NP_CODEPOINT_OFFSET = HEADER_LEN + NP_TEMPLATE_LEN;

const EBCDIC_CCSID = 37;
const EBCDIC_SPACE = 0x40;
const codec = codecForCcsid(EBCDIC_CCSID);

/** 操作 ID */
export const NP_ACTION = {
  create: 0x0001,
  open: 0x0002,
  read: 0x0003,
  write: 0x0004,
  close: 0x0005,
  hold: 0x0006,
  release: 0x0007,
  start: 0x0008,
  end: 0x0009,
  delete: 0x000a,
  move: 0x000b,
  send: 0x000c,
  changeAttributes: 0x000e,
  retrieveAttributes: 0x000f,
  /** MSGW の検出に使える（本作業では未実装） */
  retrieveMessage: 0x0011,
  /** MSGW への応答に使える（本作業では未実装） */
  answerMessage: 0x0012
} as const;

/** オブジェクト種別（ReqRep ID として使う） */
export const NP_OBJECT = {
  spooledFile: 0x0001,
  writerJob: 0x0002,
  outputQueue: 0x0004
} as const;

/** コードポイント ID（原典 NPCodePoint の定義） */
export const NP_CP = {
  spooledFileId: 0x0001,
  writerJobId: 0x0002,
  outputQueueId: 0x0003,
  printerFileId: 0x0004,
  printerDeviceId: 0x0005,
  selection: 0x0006,
  attributeList: 0x0007,
  /** 属性値。CPF メッセージもここに載る */
  attributeValue: 0x0008,
  data: 0x0009,
  targetSpooledFileId: 0x000b,
  spooledFileHandle: 0x000c,
  messageHandle: 0x000d,
  libraryId: 0x000e
} as const;

/** 属性 ID（PrintObject の ATTR_*） */
export const NP_ATTR = {
  jobName: 0x003b,
  jobNumber: 0x003c,
  jobUser: 0x003e,
  spooledFileName: 0x0068,
  spooledFileNumber: 0x0069,
  /** READ で「何バイト読むか」を指定する */
  numberOfBytes: 0x007d,
  // --- メッセージ関連（MSGW の検出・応答） ---
  messageText: 0x0080,
  messageHelp: 0x0081,
  /** 応答（返答を書き込む／期待される返答の種類） */
  messageReply: 0x0082,
  messageType: 0x008e,
  messageId: 0x0093
} as const;

/** 属性の型コード */
const ATTR_TYPE = { fourByte: 0x0003, string: 0x0005 } as const;
/** 属性エントリ 1 件の長さ（ID 2 ＋ 型 2 ＋ 値オフセット 4 ＋ 値長 4） */
const ATTR_ENTRY_LEN = 12;

/**
 * 属性値。
 *
 * **文字列は固定長で空白詰めにする**——ホストは属性ごとに決まった長さで読むため、
 * 詰めずに送ると隣の値を巻き込む（実機で "USER681803" のように値が重なって
 * CPF3342「ジョブが見つからない」になった）。
 */
export type NpAttribute =
  | { id: number; type: "string"; value: string; length: number }
  | { id: number; type: "int"; value: number };

/** 属性ごとの固定長 */
export const NP_ATTR_LEN = {
  jobName: 10,
  jobUser: 10,
  jobNumber: 6,
  spooledFileName: 10
} as const;

function encodeString(text: string): Uint8Array {
  const { bytes, substituted } = codec.encode(text.toUpperCase());
  if (substituted > 0) {
    throw new Tn5250Error(
      "CONFIG_ERROR",
      `"${text}" contains characters not representable in CCSID ${EBCDIC_CCSID}`
    );
  }
  return bytes;
}

/**
 * 属性リストを組み立てる。
 *
 * 配置: 件数(2) ＋ 要素長(2) ＋ [エントリ 12 バイト] × n ＋ 値の実体
 * エントリ: ID(2) ＋ 型(2) ＋ **値長(4) ＋ 値オフセット(4)**（この順序。逆にすると値が空で届く）
 *
 * **値オフセットはコードポイントの LL/CP ヘッダー 6 バイトを含めた位置**——
 * データ部の先頭からではない。ここを誤ると CPF3C58「ジョブ名が無効」になる。
 */
export function buildAttributeList(attributes: readonly NpAttribute[]): Uint8Array {
  const values = attributes.map((a) =>
    a.type === "string" ? padEbcdic(a.value, a.length) : intBytes(a.value)
  );
  const headerLen = 4 + ATTR_ENTRY_LEN * attributes.length;
  const total = headerLen + values.reduce((n, v) => n + v.length, 0);
  // 値オフセットはコードポイントヘッダー（LL 4 ＋ CP 2）を含めた位置で書く
  const CODEPOINT_HEADER = 6;

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint16(0, attributes.length);
  view.setUint16(2, ATTR_ENTRY_LEN);

  let entryAt = 4;
  let valueAt = headerLen;
  attributes.forEach((attr, i) => {
    const value = values[i]!;
    view.setUint16(entryAt, attr.id);
    view.setUint16(entryAt + 2, attr.type === "string" ? ATTR_TYPE.string : ATTR_TYPE.fourByte);
    view.setUint32(entryAt + 4, value.length);
    view.setUint32(entryAt + 8, valueAt + CODEPOINT_HEADER);
    out.set(value, valueAt);
    entryAt += ATTR_ENTRY_LEN;
    valueAt += value.length;
  });
  return out;
}

function intBytes(value: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setInt32(0, value);
  return b;
}

/** 空白詰めの EBCDIC */
export function padEbcdic(text: string, length: number): Uint8Array {
  const out = new Uint8Array(length).fill(EBCDIC_SPACE);
  out.set(encodeString(text).subarray(0, length));
  return out;
}

/** コードポイント */
export interface NpCodePoint {
  id: number;
  data: Uint8Array;
}

/** 要求を組み立てる */
export function buildNpRequest(opts: {
  objectType: number;
  action: number;
  codePoints: readonly NpCodePoint[];
}): Uint8Array {
  const cpLen = opts.codePoints.reduce((n, cp) => n + 6 + cp.data.length, 0);
  const total = NP_CODEPOINT_OFFSET + cpLen;
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);

  v.setUint32(0, total);
  v.setUint16(4, 0); // Header ID
  v.setUint16(6, NP_SERVER_ID);
  v.setUint32(8, 0); // CS instance
  v.setUint32(12, 0); // Correlation ID
  v.setUint16(16, NP_TEMPLATE_LEN);
  v.setUint16(18, opts.objectType);
  // テンプレート
  v.setUint16(20, opts.action);
  v.setUint32(22, 0); // フラグ
  v.setUint16(26, 0); // 戻りコード（要求では 0）
  v.setUint32(28, 0); // EO

  let pos = NP_CODEPOINT_OFFSET;
  for (const cp of opts.codePoints) {
    v.setUint32(pos, 6 + cp.data.length);
    v.setUint16(pos + 4, cp.id);
    out.set(cp.data, pos + 6);
    pos += 6 + cp.data.length;
  }
  return out;
}

/** 解析済みの応答 */
export interface NpReply {
  /** 0 が成功 */
  returnCode: number;
  codePoints: NpCodePoint[];
}

/** 応答を解釈する */
export function parseNpReply(frame: Uint8Array): NpReply {
  if (frame.length < NP_CODEPOINT_OFFSET) {
    throw new Tn5250Error(
      "PROTOCOL_ERROR",
      `network print reply too short: ${frame.length} bytes (need >= ${NP_CODEPOINT_OFFSET})`
    );
  }
  const v = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const codePoints: NpCodePoint[] = [];
  let pos = NP_CODEPOINT_OFFSET;
  while (pos + 6 <= frame.length) {
    const ll = v.getUint32(pos);
    // LL は自身の 6 バイトを含む。6 未満だと前進できず無限ループになる
    if (ll < 6 || pos + ll > frame.length) break;
    codePoints.push({ id: v.getUint16(pos + 4), data: frame.subarray(pos + 6, pos + ll) });
    pos += ll;
  }
  return { returnCode: v.getUint16(26), codePoints };
}

/** 指定 ID のコードポイントを探す */
export function findCodePoint(reply: NpReply, id: number): Uint8Array | undefined {
  return reply.codePoints.find((cp) => cp.id === id)?.data;
}

/** 戻りコード（応答テンプレートの 2 バイト） */
export const NP_RC = {
  ok: 0x0000,
  notAuthorized: 0x0008,
  /** CPF メッセージがコードポイントに載っている */
  cpfMessage: 0x0009,
  readIncomplete: 0x0012,
  /** これ以上読むものが無い（エラーではない） */
  readEof: 0x0013,
  spooledFileNoMessage: 0x000e,
  returnCodePointMissing: 0x0019
} as const;

/**
 * 属性 ID リスト（`RETRIEVE_MESSAGE` で「どの属性が欲しいか」を指定する）。
 *
 * 配置: 件数(2) ＋ 要素長(2、常に 2) ＋ [属性 ID(2)] × n
 *
 * 参照: JTOpen 本体の NPCPAttributeIDList に対応する。
 */
export function buildAttributeIdList(ids: readonly number[]): Uint8Array {
  const out = new Uint8Array(4 + ids.length * 2);
  const v = new DataView(out.buffer);
  v.setUint16(0, ids.length);
  v.setUint16(2, 2);
  ids.forEach((id, i) => v.setUint16(4 + i * 2, id));
  return out;
}

/** 属性リストを解釈して ID → 値の対応にする（`buildAttributeList` の逆） */
export function parseAttributeList(data: Uint8Array): Map<number, Uint8Array> {
  const out = new Map<number, Uint8Array>();
  if (data.length < 4) return out;
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const count = v.getUint16(0);
  const entryLen = v.getUint16(2);
  if (entryLen < 12) return out;

  for (let i = 0; i < count; i++) {
    const at = 4 + i * entryLen;
    if (at + 12 > data.length) break;
    const id = v.getUint16(at);
    const valueLen = v.getUint32(at + 4);
    // 値オフセットはコードポイントヘッダー 6 バイトを含む位置で書かれている
    const valueAt = v.getUint32(at + 8) - 6;
    if (valueAt < 0 || valueAt + valueLen > data.length) continue;
    out.set(id, data.subarray(valueAt, valueAt + valueLen));
  }
  return out;
}
