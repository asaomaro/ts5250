/**
 * データ待ち行列サーバー（QZHQSSRV / as-dtaq）のデータストリーム。
 *
 * signon 系と同じ 20 バイトヘッダー。
 * **キュー名・ライブラリ名は EBCDIC 10 バイト固定（0x40 詰め）**——
 * IFS のファイル名（UTF-16BE 可変長 LL/CP）とは流儀が違う。
 * エントリ本体は CP=0x5001 の LL/CP、キーは CP=0x5002。データ本体は CCSID 宣言なしの生バイト。
 *
 * 参照: JTOpen(IBM Toolbox for Java) の `DQ*DataStream` クラス群。
 * 配置は research 工程で実機採取して確定させる（宣言テンプレート長からは応答のデータ開始位置を
 * 求められないため。IFS で踏んだ罠）。
 */
import { As400Error } from "../../errors.js";
import { codecForCcsid } from "../../codec/codec.js";
import type {
  CreateOptions,
  DtaqAttributes,
  DtaqEntry,
  DtaqType,
  ReadOptions
} from "./dtaq-types.js";

export type {
  CreateOptions,
  DtaqAttributes,
  DtaqEntry,
  DtaqType,
  ReadOptions,
  SearchOrder
} from "./dtaq-types.js";

/** データ待ち行列サーバーのサーバー ID */
export const DTAQ_SERVER_ID = 0xe007;

/** 要求 ID（ReqRep ID） */
export const DTAQ_REQ = {
  exchangeAttributes: 0x0000,
  requestAttributes: 0x0001,
  read: 0x0002,
  create: 0x0003,
  delete: 0x0004,
  write: 0x0005,
  clear: 0x0006
} as const;

/** 応答 ID */
export const DTAQ_REPLY = {
  exchangeAttributes: 0x8000,
  requestAttributes: 0x8001,
  common: 0x8002,
  read: 0x8003
} as const;

/** 名前・ライブラリの CCSID（システム SBCS）。PUB400 は 273 */
const NAME_CCSID = 273;
/** エントリ本体のコードポイント */
const CP_ENTRY = 0x5001;
/** キーのコードポイント */
const CP_KEY = 0x5002;
/** キーなし／キー付きの指示 */
const KEY_NONE = 0xf0;
const KEY_YES = 0xf1;

/** 戻りコード（共通応答 0x8002 の offset20） */
export const DTAQ_RC = {
  success: 0xf000,
  commandCheck: 0xf001,
  /** キー付きでないのにキーを指定した等の不整合 */
  keyMismatch: 0xf002,
  noData: 0xf006
} as const;

function writeHeader(v: DataView, total: number, templateLen: number, reqId: number): void {
  v.setUint32(0, total);
  v.setUint16(4, 0); // Header ID
  v.setUint16(6, DTAQ_SERVER_ID);
  v.setUint32(8, 0); // CS instance
  v.setUint32(12, 0); // Correlation ID
  v.setUint16(16, templateLen);
  v.setUint16(18, reqId);
}

/**
 * キュー名・ライブラリを EBCDIC 10 バイト（0x40 詰め）で offset 20/30 に書く。
 * variant 文字（@ # $）は CCSID 依存で化けるので、システム CCSID で変換する。
 */
function writeNameAndLibrary(out: Uint8Array, name: string, library: string): void {
  const codec = codecForCcsid(NAME_CCSID);
  const put = (text: string, at: number): void => {
    out.fill(0x40, at, at + 10); // まず全部スペース
    const { bytes } = codec.encode(text.slice(0, 10));
    out.set(bytes.subarray(0, 10), at);
  };
  put(name, 20);
  put(library, 30);
}

/**
 * EBCDIC の固定長フィールドを文字列に戻す（末尾の詰めスペースを落とす）。
 *
 * **デコード後の文字列に対して 0x40 を消そうとしないこと**——EBCDIC の 0x40（スペース）は
 * デコード済み文字列では U+0020 になっており、`\x40` は '@'（U+0040）を指してしまう。
 * それをやると末尾が '@' の値（variant 文字）を取りこぼす。詰めスペースは `trimEnd()` が正しく落とす。
 */
export function decodeEbcdic(bytes: Uint8Array): string {
  return codecForCcsid(NAME_CCSID).decode(bytes).trimEnd();
}

/**
 * 交換属性要求（0x0000）。**接続時に必ず送る**。
 * クライアント版 0x00000001（64K データキュー対応）＋ データストリームレベル 0x0000。
 */
export function buildExchangeAttributes(): Uint8Array {
  const total = 26;
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  writeHeader(v, total, 6, DTAQ_REQ.exchangeAttributes);
  v.setUint32(20, 0x00000001); // クライアント版
  v.setUint16(24, 0x0000); // データストリームレベル
  return out;
}

const TYPE_BYTE: Record<DtaqType, number> = { FIFO: 0xf0, LIFO: 0xf1, KEYED: 0xf2 };
/** 属性応答の type バイト下位 4bit → 種別 */
const TYPE_FROM_BYTE: Record<number, DtaqType> = { 0: "FIFO", 1: "LIFO", 2: "KEYED" };

/** 作成要求（0x0003）。全長 100 / TemplateLen 80 */
export function buildCreate(opts: CreateOptions): Uint8Array {
  const total = 100;
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  writeHeader(v, total, 80, DTAQ_REQ.create);
  writeNameAndLibrary(out, opts.name, opts.library);
  v.setUint32(40, opts.maxEntryLength);
  out[44] = 0xf1; // 権限 *CHANGE
  out[45] = opts.saveSender ? 0xf1 : 0xf0;
  out[46] = TYPE_BYTE[opts.type];
  v.setUint16(47, opts.keyLength ?? 0);
  out[49] = 0xf0; // force = *NO
  // 説明 50 バイト（offset 50〜99）。EBCDIC・スペース詰め
  out.fill(0x40, 50, 100);
  if (opts.description) {
    const { bytes } = codecForCcsid(NAME_CCSID).encode(opts.description.slice(0, 50));
    out.set(bytes.subarray(0, 50), 50);
  }
  return out;
}

/** 削除要求（0x0004）。全長 40 / TemplateLen 20 */
export function buildDelete(name: string, library: string): Uint8Array {
  const total = 40;
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  writeHeader(v, total, 20, DTAQ_REQ.delete);
  writeNameAndLibrary(out, name, library);
  return out;
}

/**
 * 送信要求（0x0005）。
 * 非キー: 全長 48 + entryLen / キー付き: 54 + entryLen + keyLen。TemplateLen 22。
 */
export function buildWrite(
  name: string,
  library: string,
  entry: Uint8Array,
  key?: Uint8Array
): Uint8Array {
  const keyed = key !== undefined;
  const total = (keyed ? 54 : 48) + entry.length + (keyed ? key.length : 0);
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  writeHeader(v, total, 22, DTAQ_REQ.write);
  writeNameAndLibrary(out, name, library);
  out[40] = keyed ? KEY_YES : KEY_NONE;
  out[41] = 0xf1; // 応答要求
  // エントリ LL/CP: LL = 6 + entryLen, CP = 0x5001
  let at = 42;
  v.setUint32(at, entry.length + 6); at += 4;
  v.setUint16(at, CP_ENTRY); at += 2;
  out.set(entry, at); at += entry.length;
  if (keyed) {
    v.setUint32(at, key.length + 6); at += 4;
    v.setUint16(at, CP_KEY); at += 2;
    out.set(key, at);
  }
  return out;
}

/**
 * 受信要求（0x0002）。
 * 非キー: 全長 48 / キー付き: 54 + keyLen。TemplateLen 28。
 */
export function buildRead(opts: ReadOptions): Uint8Array {
  const key = opts.key;
  const total = (key ? 54 : 48) + (key ? key.length : 0);
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  writeHeader(v, total, 28, DTAQ_REQ.read);
  writeNameAndLibrary(out, opts.name, opts.library);
  out[40] = key ? KEY_YES : KEY_NONE;
  // 検索条件 EBCDIC 2 バイト（非キーは 0x0000）
  if (key && opts.search) {
    const { bytes } = codecForCcsid(NAME_CCSID).encode(opts.search);
    out[41] = bytes[0] ?? 0;
    out[42] = bytes[1] ?? 0;
  }
  // 待機秒 32 ビット符号付き（-1 = 無限）
  v.setInt32(43, opts.wait);
  out[47] = opts.peek ? 0xf1 : 0xf0;
  if (key) {
    let at = 48;
    v.setUint32(at, key.length + 6); at += 4;
    v.setUint16(at, CP_KEY); at += 2;
    out.set(key, at);
  }
  return out;
}

/** クリア要求（0x0006）。非キー: 全長 41 / キー付き: 47 + keyLen。TemplateLen 21 */
export function buildClear(name: string, library: string, key?: Uint8Array): Uint8Array {
  const keyed = key !== undefined;
  const total = (keyed ? 47 : 41) + (keyed ? key.length : 0);
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  writeHeader(v, total, 21, DTAQ_REQ.clear);
  writeNameAndLibrary(out, name, library);
  out[40] = keyed ? KEY_YES : KEY_NONE;
  if (keyed) {
    let at = 41;
    v.setUint32(at, key.length + 6); at += 4;
    v.setUint16(at, CP_KEY); at += 2;
    out.set(key, at);
  }
  return out;
}

/** 属性取得要求（0x0001）。全長 40 / TemplateLen 20 */
export function buildRequestAttributes(name: string, library: string): Uint8Array {
  const total = 40;
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  writeHeader(v, total, 20, DTAQ_REQ.requestAttributes);
  writeNameAndLibrary(out, name, library);
  return out;
}

/** 応答の ReqRep ID */
export function replyId(frame: Uint8Array): number {
  if (frame.length < 20) {
    throw new As400Error("PROTOCOL_ERROR", `dtaq reply too short: ${frame.length} bytes`);
  }
  return new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint16(18);
}

/** 共通応答（0x8002）の戻りコード（offset 20 の 16 ビット） */
export function commonReplyRc(frame: Uint8Array): number {
  // rc は offset20-21。replyId は length>=20 しか保証しないので、ここで 22 を確かめる
  // （足りないと getUint16 が生の RangeError を投げ、呼び出し側が分類できなくなる）
  if (frame.length < 22) {
    throw new As400Error("PROTOCOL_ERROR", `dtaq common reply too short: ${frame.length} bytes`);
  }
  return new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint16(20);
}

/**
 * 受信正常応答（0x8003）を解いてエントリを返す。
 *
 * 配置は**実機のダンプで確定**（research F2）:
 * 送信者情報 offset 22〜57（36 バイト固定）、エントリは offset 58 から LL/CP（CP=0x5001）。
 * **宣言テンプレート長からは導かない**（IFS で踏んだ罠。20+templateLen と一致するのは
 * 送信者情報が 36 バイト固定であることに依存した偶然に近い）。
 * 送信者情報の先頭が 0x40（スペース）なら「情報なし」として落とす。
 */
export function parseReadReply(frame: Uint8Array): DtaqEntry {
  const v = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const senderInfo = frame.subarray(22, 58);
  let at = 58;
  while (at + 6 <= frame.length) {
    const ll = v.getUint32(at);
    const cp = v.getUint16(at + 4);
    if (cp === CP_ENTRY) {
      const dataLen = Math.max(0, ll - 6);
      const start = at + 6;
      return {
        data: frame.subarray(start, Math.min(start + dataLen, frame.length)),
        ...(senderInfo.length === 36 && senderInfo[0] !== 0x40 ? { senderInfo } : {})
      };
    }
    if (ll <= 0) break; // 壊れた LL で無限ループしない
    at += ll;
  }
  return { data: new Uint8Array(0) };
}

/**
 * 属性取得正常応答（0x8001）を解く。
 *
 * 原典（JTOpen `DQQueryReplyDataStream`）の仮定: maxEntryLength@22(4B),
 * saveSender@26(0xF1/0xF0), type@27 の下位 4bit（0=FIFO/1=LIFO/2=KEYED）, keyLength@28(2B)。
 * **実機採取（T9）で確定させる**。原典どおりに書いて壊れたら固定オフセットを差し替える。
 */
export function parseAttributesReply(frame: Uint8Array): DtaqAttributes {
  if (frame.length < 30) {
    throw new As400Error("PROTOCOL_ERROR", `dtaq attributes reply too short: ${frame.length} bytes`);
  }
  const v = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const maxEntryLength = v.getUint32(22);
  const saveSender = frame[26] === 0xf1;
  const typeNibble = (frame[27] ?? 0) & 0x0f;
  const type = TYPE_FROM_BYTE[typeNibble];
  if (type === undefined) {
    throw new As400Error("PROTOCOL_ERROR", `dtaq attributes: unknown type byte 0x${(frame[27] ?? 0).toString(16)}`);
  }
  const keyLength = v.getUint16(28);
  return { maxEntryLength, type, keyLength, saveSender };
}

/** メッセージ ID の接頭辞（EBCDIC）。CPF/CPD/CPC/MCH を拾う */
const MSG_PREFIXES = ["CPF", "CPD", "CPC", "MCH"];

/**
 * 共通応答（0x8002）のフレームから CPF などのメッセージ ID を取り出す。
 *
 * **固定オフセットを決め打ちしない**——エラー応答のメッセージ位置は実機未採取なので、
 * フレーム全体を走査して「接頭辞 3 文字（英字）＋数字 4 桁」の EBCDIC 並びを探す。
 * 位置に依存しないぶん、実機のレイアウトが原典と食い違っても壊れない。見つからなければ undefined。
 */
export function parseCpfId(frame: Uint8Array): string | undefined {
  const codec = codecForCcsid(NAME_CCSID);
  for (let i = 20; i + 7 <= frame.length; i++) {
    const slice = frame.subarray(i, i + 7);
    const text = codec.decode(slice);
    const prefix = text.slice(0, 3);
    if (MSG_PREFIXES.includes(prefix) && /^[0-9A-F]{4}$/u.test(text.slice(3, 7))) {
      return text;
    }
  }
  return undefined;
}

/** NOT_FOUND に写す CPF（オブジェクトなし） */
const CPF_NOT_FOUND = new Set(["CPF9801", "CPF2105", "CPF3AA1"]);
/** ACCESS_DENIED に写す CPF（権限なし） */
const CPF_ACCESS_DENIED = new Set(["CPF9802", "CPF2189", "CPF2216"]);
/** ALREADY_EXISTS に写す CPF（既に存在） */
const CPF_ALREADY_EXISTS = new Set(["CPF9870"]);

/**
 * 共通応答（0x8002）の rc と CPF メッセージを、**呼び出し側が区別できる** `As400Error` に写す。
 *
 * まとめて `PROTOCOL_ERROR` にすると server 側で 502（＝上流の通信失敗）に落ち、
 * 「ホストが落ちている」と「指定が間違っている」を利用者が区別できなくなる（IFS の `fileFailure` と同じ理由）。
 * rc=0xF006（データなし）はここに来ない——`read` が undefined に写す。
 */
export function dtaqFailure(what: string, frame: Uint8Array): As400Error {
  const id = replyId(frame);
  if (id !== DTAQ_REPLY.common) {
    // 共通応答でない＝rc を語らない。offset20 を rc として文言にすると無意味な表示になる
    return new As400Error(
      "PROTOCOL_ERROR",
      `${what}: unexpected reply 0x${id.toString(16).padStart(4, "0")}`
    );
  }
  const rc = commonReplyRc(frame);
  const cpf = parseCpfId(frame);
  const detail = `${what} failed (rc=0x${rc.toString(16)}${cpf ? `, ${cpf}` : ""})`;
  if (cpf) {
    if (CPF_NOT_FOUND.has(cpf)) return new As400Error("NOT_FOUND", detail);
    if (CPF_ACCESS_DENIED.has(cpf)) return new As400Error("ACCESS_DENIED", detail);
    if (CPF_ALREADY_EXISTS.has(cpf)) return new As400Error("ALREADY_EXISTS", detail);
  }
  // キー付きでないのにキーを指定した等の不整合
  if (rc === DTAQ_RC.keyMismatch) return new As400Error("CONFIG_ERROR", detail);
  return new As400Error("PROTOCOL_ERROR", detail);
}
