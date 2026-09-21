import { As400Error } from "@ts5250/base";
import { ByteReader, ByteWriter } from "./bytes.js";
import { GDS_TYPE, HDR_FLAG } from "./constants.js";

export interface RecordHeaderFlags {
  err: boolean;
  atn: boolean;
  srq: boolean;
  trq: boolean;
  hlp: boolean;
}

export interface ParsedRecord {
  opcode: number;
  flags: RecordHeaderFlags;
  /** ヘッダを除いたデータストリーム本体 */
  data: Uint8Array;
}

/**
 * GDS レコードヘッダ（RFC 1205）を解析する。
 * LL(2) + type(2)=0x12A0 + reserved(2) + varHdrLen(1) + flags(2) + opcode(1) + data...
 */
export function parseRecord(record: Uint8Array): ParsedRecord {
  const r = new ByteReader(record);
  const ll = r.u16();
  if (ll !== record.length) {
    throw new As400Error("PROTOCOL_ERROR", `record length mismatch: LL=${ll}, actual=${record.length}`);
  }
  const type = r.u16();
  if (type !== GDS_TYPE) {
    throw new As400Error("PROTOCOL_ERROR", `unexpected GDS type 0x${type.toString(16)}`);
  }
  r.skip(2); // reserved
  // Variable Header Length は自身の 1 バイトを含む（=0x04 で flags(2)+opcode(1) が続く）
  const varHdrLen = r.u8();
  if (varHdrLen < 4) {
    throw new As400Error("PROTOCOL_ERROR", `variable header too short: ${varHdrLen}`);
  }
  const flag1 = r.u8();
  r.u8(); // flags 2 バイト目（未使用）
  const opcode = r.u8();
  r.skip(varHdrLen - 4); // 将来の拡張ヘッダを読み飛ばす
  return {
    opcode,
    flags: {
      err: (flag1 & HDR_FLAG.ERR) !== 0,
      atn: (flag1 & HDR_FLAG.ATN) !== 0,
      srq: (flag1 & HDR_FLAG.SRQ) !== 0,
      trq: (flag1 & HDR_FLAG.TRQ) !== 0,
      hlp: (flag1 & HDR_FLAG.HLP) !== 0
    },
    data: record.subarray(r.offset)
  };
}

/**
 * **クライアント発レコードのフラグ 2 バイト目**。
 *
 * ACS はクライアント → ホストの全レコードでこれを立てる（`DS5250.sendAll` / `processReadScreen` /
 * `processReadScreenEA` / `processSaveScreen` のいずれもヘッダ生成で 0x80）。
 * 以前は READ SCREEN EXTENDED(0x64) の応答と Query Reply だけに付けていた——
 * 0x64 で立てないと実機からヘルプ画面が返ってこなかったのが分かった時に、そこだけ直したため。
 * ACS に合わせて**クライアント発は全部立てる**。
 */
export const CLIENT_FLAG2 = 0x80;

/**
 * クライアント → ホストのレコードを GDS ヘッダ付きで構築する。
 * flag2 はフラグ 2 バイト目。ACS 実機はクライアント発のレコードで常に 0x80 を立てている
 * （`CLIENT_FLAG2`）。
 */
export function buildRecord(
  opcode: number,
  data: Uint8Array,
  flags: Partial<RecordHeaderFlags> = {},
  flag2 = 0
): Uint8Array {
  const w = new ByteWriter();
  const ll = 10 + data.length; // LL(2)+type(2)+reserved(2)+varHdrLen(1)+flags(2)+opcode(1)
  let flag1 = 0;
  if (flags.err === true) flag1 |= HDR_FLAG.ERR;
  if (flags.atn === true) flag1 |= HDR_FLAG.ATN;
  if (flags.srq === true) flag1 |= HDR_FLAG.SRQ;
  if (flags.trq === true) flag1 |= HDR_FLAG.TRQ;
  if (flags.hlp === true) flag1 |= HDR_FLAG.HLP;
  w.u16(ll).u16(GDS_TYPE).u16(0).u8(0x04).u8(flag1).u8(flag2).u8(opcode).bytes(data);
  return w.toUint8Array();
}

/**
 * **否定応答**（`20260921-negative-responses`）。ACS `DS5250.tokenizeData` の終わりで送る形と同じ:
 * ヘッダのフラグ 1 に ERR（0x80）、フラグ 2 は 0、オペコードは 0、データはセンス・コード 4 バイト（`00 0E 12 A0 00 00 04 80 00 00 <センス>`）
 */
export function buildNegativeResponse(senseCode: number): Uint8Array {
  const sense = Uint8Array.from([(senseCode >>> 24) & 0xff, (senseCode >>> 16) & 0xff, (senseCode >>> 8) & 0xff, senseCode & 0xff]);
  return buildRecord(0x00, sense, { err: true }, 0);
}
