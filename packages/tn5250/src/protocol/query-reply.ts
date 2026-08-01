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
/**
 * 5250 QUERY（WSF class 0xD9 / type 0x70）への Query Reply を構築する（SC30-3533 表89）。
 * terminalType で device type/model を広告する（IBM-3179-2 / IBM-3477-FC / IBM-5555-C01 等）。
 *
 * **バイト列は ACS 実機（IBM i 日本語機）の Query Reply を実測して一致させてある。**
 * 能力申告が違うと、ホストはヘルプやウィンドウの描き方を別経路に切り替える。実測では
 * 当方の旧申告だと PDM の F1 ヘルプが CLEAR UNIT ALTERNATE（27x132）経路に落ち、
 * 24x80 用に組まれた背景が 132 桁に流し込まれてレイアウトが崩れた。
 */
export function buildQueryReply(terminalType = "IBM-3179-2", enhanced = false): Uint8Array {
  void enhanced; // ACS 実機と同じ申告に統一する（拡張は常に広告する。t[53]/t[54] 参照）
  const { type, model } = typeAndModel(terminalType);
  const t = new Uint8Array(71);
  t[0] = 0x00; // カーソル行
  t[1] = 0x00; // カーソル桁
  t[2] = 0x88; // Inbound Write Structured Field AID
  t[3] = 0x00; // Query Reply 長（上位）
  t[4] = 0x44; // Query Reply 長（下位）= 68
  t[5] = 0xd9; // command class
  t[6] = 0x70; // command type = Query
  t[7] = 0x80; // flag
  t[8] = 0x05; // controller hardware class
  t[9] = 0x00;
  t[10] = 0x03; // controller code level
  t[11] = 0x02;
  // t[12..28] = 0（予約）
  t[29] = 0x01; // display emulation
  // device type（4 桁）＋ model（**3 桁**）を EBCDIC で連続配置。
  // モデルを 2 桁しか送らないと "C01" の先頭 'C' が落ち、ホストに別モデルとして見える。
  const dt = type.padStart(4, "0").slice(0, 4);
  t[30] = toEbcdic(dt[0]!);
  t[31] = toEbcdic(dt[1]!);
  t[32] = toEbcdic(dt[2]!);
  t[33] = toEbcdic(dt[3]!);
  const md = model.padStart(3, "0").slice(-3);
  t[34] = toEbcdic(md[0]!);
  t[35] = toEbcdic(md[1]!);
  t[36] = toEbcdic(md[2]!);
  t[37] = 0x01; // Keyboard ID
  t[38] = 0x01;
  t[42] = 0x70; // display serial number
  t[43] = 0x12;
  t[44] = 0x01; // 最大入力フィールド数 = 500
  t[45] = 0xf4;
  t[49] = 0x7b; // controller/display capability
  t[50] = 0x31; // bit0-3=0011: 24x80 と 27x132 の両対応
  t[52] = 0x40;
  t[53] = 0x0f; // 拡張 5250（FCW & WDSF 等）
  t[54] = 0xc8; // 拡張ユーザーインターフェース
  t[61] = 0x01;
  t[62] = 0x01;
  // opcode は PUT_GET(0x03)・フラグ 2 バイト目 0x80。ACS 実機はこれで返す。
  return buildRecord(OPCODE.PUT_GET, t, {}, 0x80);
}
