/**
 * コマンドサーバー（QZRCSRVS）のデータストリーム。
 *
 * signon と**同じ 20 バイトヘッダー**（database のような 20 バイト template は無い）。
 * template の長さと中身は要求ごとに違う。
 *
 * 参照: JTOpen(jtopenlite) の CommandConnection.sendExchangeAttributesRequest /
 *       sendRunCommandRequest / sendCallProgramRequest に対応する。
 */
import { As400Error } from "../../errors.js";
import { HEADER_LEN } from "../datastream.js";
import { codecForCcsid } from "../../codec/codec.js";

/** コマンドサーバーのサーバー ID（signon は 0xE009、database は 0xE004） */
export const COMMAND_SERVER_ID = 0xe008;

/** 資格情報や識別子と同じく CCSID 37 固定 */
const EBCDIC_CCSID = 37;
const EBCDIC_SPACE = 0x40;
/** 名前欄の長さ（プログラム名・ライブラリ名） */
const NAME_LEN = 10;

/** 要求 ID */
export const CMD_REQ = {
  exchangeAttributes: 0x1001,
  runCommand: 0x1002,
  callProgram: 0x1003
} as const;

/** メッセージのコードポイント */
export const MSG_CP = {
  /** 長さ前置の形式（新しいサーバー） */
  extended: 0x1106,
  /** 固定長の形式（古いサーバー） */
  original: 0x1102
} as const;

/** コマンド文字列のコードポイント */
const CP_COMMAND_UNICODE = 0x1104;
/** プログラム呼び出しのパラメータ。応答でも同じ CP で返る */
export const CP_PARAMETER = 0x1103;
/** クライアント CCSID（UTF-16BE） */
const CLIENT_CCSID = 1200;
/** 全メッセージを返させるオプション（レベル 10 以上） */
const MESSAGE_OPTION_ALL = 4;

/**
 * この実装が対応する最小データストリームレベル。
 *
 * 10 未満はコマンド文字列を CCSID 37 / CP 0x1101 で送る別経路になる。
 * 実機（PUB400 はレベル 11）で確認する手段が無いため未対応とし、
 * **黙って誤った書式を送らない**（紛らわしい「コマンドが見つからない」になる）。
 */
export const MIN_DATASTREAM_LEVEL = 10;

/** 戻りコード: 成功 */
export const RC_OK = 0;
/** 戻りコード: 失敗（メッセージあり） */
export const RC_FAILED_WITH_MESSAGES = 0x0400;

/** 応答の戻りコード（2 バイト）とメッセージ件数（2 バイト）の位置 */
export const REPLY_RC_OFFSET = HEADER_LEN;
export const REPLY_MESSAGE_COUNT_OFFSET = HEADER_LEN + 2;
export const REPLY_MESSAGES_OFFSET = HEADER_LEN + 4;

/** UTF-16BE のバイト列 */
function utf16be(text: string): Uint8Array {
  const out = new Uint8Array(text.length * 2);
  const v = new DataView(out.buffer);
  for (let i = 0; i < text.length; i++) v.setUint16(i * 2, text.charCodeAt(i));
  return out;
}

/** CCSID 37 の EBCDIC で固定長・空白詰め */
function ebcdicPad(text: string, length: number, what: string): Uint8Array {
  const upper = text.toUpperCase();
  if (upper.length > length) {
    throw new As400Error("CONFIG_ERROR", `${what} too long: "${text}" (max ${length})`);
  }
  const { bytes, substituted } = codecForCcsid(EBCDIC_CCSID).encode(upper);
  if (substituted > 0) {
    throw new As400Error(
      "CONFIG_ERROR",
      `${what} contains characters not representable in CCSID ${EBCDIC_CCSID}: "${text}"`
    );
  }
  const out = new Uint8Array(length).fill(EBCDIC_SPACE);
  out.set(bytes.subarray(0, length));
  return out;
}

/** 20 バイトヘッダーを書く */
function writeHeader(view: DataView, total: number, templateLen: number, reqId: number): void {
  view.setUint32(0, total);
  view.setUint16(4, 0); // Header ID
  view.setUint16(6, COMMAND_SERVER_ID);
  view.setUint32(8, 0); // CS instance
  view.setUint32(12, 0); // Correlation ID
  view.setUint16(16, templateLen);
  view.setUint16(18, reqId);
}

/**
 * 交換属性要求（0x1001）。
 *
 * **接続時に必ず送る**——これでデータストリームレベルが分かり、
 * コマンド文字列の書式が決まる。送らずにコマンドを投げると応答が解釈不能になる。
 *
 * @param nlv 各国語版（既定 "2924" = 英語）
 */
export function buildExchangeAttributesRequest(nlv = "2924"): Uint8Array {
  const total = 34;
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  writeHeader(v, total, 14, CMD_REQ.exchangeAttributes);
  v.setUint32(20, CLIENT_CCSID);
  out.set(ebcdicPad(nlv, 4, "NLV"), 24);
  v.setUint32(28, 1); // クライアント版数
  v.setUint16(32, 0); // クライアントデータストリームレベル
  return out;
}

/** 交換属性の応答 */
export interface CommandServerInfo {
  ccsid: number;
  /** 例 "2924" */
  nlv: string;
  /** VRM 表記。例 "V7R5M0" */
  version: string;
  /** コマンド書式の分岐に使う */
  datastreamLevel: number;
}

/** 交換属性の応答の template 長。この値を前提に固定オフセットで読む */
const EXCHANGE_TEMPLATE_LEN = 16;

/**
 * 交換属性の応答を解釈する。
 *
 * **template 長を決め打ちせず、フレームが宣言した値を検証する**——
 * 前段 signon で「パラメータ開始位置を決め打ちして壊れる」問題を踏んでいるため、
 * 想定外の長さなら黙って誤った位置を読まずに失敗させる。
 */
export function parseExchangeAttributesReply(frame: Uint8Array): CommandServerInfo {
  const minLen = HEADER_LEN + EXCHANGE_TEMPLATE_LEN;
  if (frame.length < minLen) {
    throw new As400Error(
      "PROTOCOL_ERROR",
      `command server exchange attributes reply too short: ${frame.length} bytes`
    );
  }
  const v = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const templateLen = v.getUint16(16);
  if (templateLen !== EXCHANGE_TEMPLATE_LEN) {
    throw new As400Error(
      "PROTOCOL_ERROR",
      `unexpected exchange attributes template length ${templateLen} ` +
        `(expected ${EXCHANGE_TEMPLATE_LEN}); cannot read fields at fixed offsets`
    );
  }
  const rc = v.getUint16(REPLY_RC_OFFSET);
  if (rc !== RC_OK) {
    throw new As400Error(
      "PROTOCOL_ERROR",
      `command server exchange attributes failed (rc=0x${rc.toString(16)})`
    );
  }
  const raw = v.getUint32(30);
  return {
    ccsid: v.getUint16(24),
    nlv: codecForCcsid(EBCDIC_CCSID).decode(frame.subarray(26, 30)),
    // VRM は上位 16 ビットがバージョン（前段 signon と同じ規則）
    version: `V${(raw >>> 16) & 0xffff}R${(raw >>> 8) & 0xff}M${raw & 0xff}`,
    datastreamLevel: v.getUint16(34)
  };
}

/**
 * コマンド実行要求（0x1002）。
 *
 * レベル 10 以上のみ——コマンドは UTF-16BE、CP 0x1104、CCSID を 4 バイト前置する。
 */
export function buildRunCommandRequest(command: string): Uint8Array {
  if (command.length === 0) {
    throw new As400Error("CONFIG_ERROR", "command is empty");
  }
  const cmd = utf16be(command);
  const total = 31 + cmd.length;
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  writeHeader(v, total, 1, CMD_REQ.runCommand);
  v.setUint8(20, MESSAGE_OPTION_ALL);
  v.setUint32(21, 10 + cmd.length);
  v.setUint16(25, CP_COMMAND_UNICODE);
  v.setUint32(27, CLIENT_CCSID);
  out.set(cmd, 31);
  return out;
}

/** プログラム呼び出しのパラメータ */
export type ProgramParameter =
  | { type: "in"; data: Uint8Array }
  | { type: "out"; length: number }
  | { type: "inout"; data: Uint8Array; length: number }
  | { type: "null" };

/** パラメータ種別のコード */
const PARAM_TYPE = { null: 255, in: 1, out: 2, inout: 3 } as const;

function paramInput(p: ProgramParameter): Uint8Array {
  if (p.type === "in" || p.type === "inout") return p.data;
  return new Uint8Array(0);
}

/** そのパラメータが必要とする最大長（入力と出力の大きい方） */
export function paramMaxLength(p: ProgramParameter): number {
  switch (p.type) {
    case "in":
      return p.data.length;
    case "out":
      return p.length;
    case "inout":
      return Math.max(p.data.length, p.length);
    case "null":
      return 0;
  }
}

/** プログラム呼び出し要求（0x1003） */
export function buildCallProgramRequest(
  program: string,
  library: string,
  params: readonly ProgramParameter[]
): Uint8Array {
  const total = 43 + params.reduce((n, p) => n + 12 + paramInput(p).length, 0);
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  writeHeader(v, total, 23, CMD_REQ.callProgram);
  out.set(ebcdicPad(program, NAME_LEN, "program name"), 20);
  out.set(ebcdicPad(library, NAME_LEN, "library name"), 30);
  v.setUint8(40, MESSAGE_OPTION_ALL);
  v.setUint16(41, params.length);

  let pos = 43;
  for (const p of params) {
    const input = paramInput(p);
    v.setUint32(pos, 12 + input.length);
    v.setUint16(pos + 4, CP_PARAMETER);
    v.setUint32(pos + 6, paramMaxLength(p));
    v.setUint16(pos + 10, PARAM_TYPE[p.type]);
    out.set(input, pos + 12);
    pos += 12 + input.length;
  }
  return out;
}
