import { OPCODE } from "./constants.js";
import { buildRecord } from "./gds.js";

/** 端末タイプ名（IBM-3179-2 等）から device type と model を取り出す */
function typeAndModel(terminalType: string): { type: string; model: string } {
  const m = /^IBM-([0-9]+)-([0-9A-Za-z]+)$/.exec(terminalType);
  if (!m) return { type: "3179", model: "2" };
  return { type: m[1]!, model: m[2]! };
}

/** ASCII 文字を EBCDIC(CCSID 37) にマップ（device type/model の数字・英字のみ） */
function toEbcdic(ch: string): number {
  const c = ch.charCodeAt(0);
  if (c >= 0x30 && c <= 0x39) return 0xf0 + (c - 0x30); // 0-9
  if (c >= 0x41 && c <= 0x49) return 0xc1 + (c - 0x41); // A-I
  if (c >= 0x4a && c <= 0x52) return 0xd1 + (c - 0x4a); // J-R
  if (c >= 0x53 && c <= 0x5a) return 0xe2 + (c - 0x53); // S-Z
  return 0x00;
}

/**
 * 5250 QUERY（WSF class 0xD9 / type 0x70）への Query Reply を構築する（SC30-3533 表89）。
 * terminalType で device type/model を広告する（IBM-3179-2 / IBM-3477-FC / IBM-5555-C01 等）。
 * これにより host は 27x132・DBCS 対応端末には対応データストリームを送る。
 * バイト列は GNU tn5250 の query_reply に準拠。
 *
 * enhanced=true で拡張 5250（GUI 構造体: Create Window / Define Selection Field / Scroll Bar 等）を広告する。
 * このとき Query Reply 長を 0x40（64）に伸ばし、controller/display capability の
 * t[53]=0x02（拡張 5250 FCW & WDSF）・t[54]=0x80（拡張 UI レベル 2）を立てる（tn5250 query_reply と一致）。
 */
export function buildQueryReply(terminalType = "IBM-3179-2", enhanced = false): Uint8Array {
  const { type, model } = typeAndModel(terminalType);
  const t = new Uint8Array(enhanced ? 67 : 61);
  t[0] = 0x00; // cursor row
  t[1] = 0x00; // cursor col
  t[2] = 0x88; // Inbound Write Structured Field AID
  t[3] = 0x00; // Query Reply 長（上位）
  t[4] = enhanced ? 0x40 : 0x3a; // Query Reply 長（下位）: 拡張=64 / 非拡張=58
  t[5] = 0xd9; // command class
  t[6] = 0x70; // command type = Query
  t[7] = 0x80; // flag
  t[8] = 0x06; // controller hardware class
  t[9] = 0x00;
  t[10] = 0x01; // controller code level
  t[11] = 0x01;
  t[12] = 0x00;
  // t[13..28] = 0（予約）
  t[29] = 0x01; // display emulation
  // device type（4 桁）＋ model（2-3 桁）を EBCDIC で（terminalType 由来）
  const dt = type.padStart(4, "0").slice(0, 4);
  t[30] = toEbcdic(dt[0]!);
  t[31] = toEbcdic(dt[1]!);
  t[32] = toEbcdic(dt[2]!);
  t[33] = toEbcdic(dt[3]!);
  t[34] = 0x00;
  const md = model.padStart(2, "0");
  t[35] = toEbcdic(md[md.length - 2]!);
  t[36] = toEbcdic(md[md.length - 1]!);
  t[37] = 0x02; // Keyboard ID = 標準
  t[38] = 0x00;
  t[39] = 0x00;
  t[40] = 0x00; // display serial number
  t[41] = 0x61;
  t[42] = 0x50;
  t[43] = 0x00;
  t[44] = 0xff; // 最大入力フィールド数
  t[45] = 0xff;
  t[46] = 0x00;
  t[47] = 0x00;
  t[48] = 0x00;
  t[49] = 0x23; // controller/display capability
  t[50] = 0x31;
  t[51] = 0x00;
  t[52] = 0x00;
  if (enhanced) {
    t[53] = 0x02; // 拡張 5250 FCW & WDSF（GUI 構造体を受け付ける）
    t[54] = 0x80; // 拡張ユーザーインターフェース サポートレベル 2
  } else {
    t[53] = 0x00; // 非拡張（graphics/mouse/enhanced なし）
    t[54] = 0x00;
  }
  // t[55..] = 0（拡張時 t[55..66] も 0）
  return buildRecord(OPCODE.NOOP, t);
}
