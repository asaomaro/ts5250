/**
 * 5250 データストリーム定数（SC30-3533-04 / RFC 1205。名前は文書の用語に合わせる）。
 * SBCS サブセット（subtask 01 scope）。WSF/QUERY・DBCS 関連は subtask 04 で追加。
 */

/** GDS レコード種別（RFC 1205） */
export const GDS_TYPE = 0x12a0;

/** レコードヘッダの opcode（RFC 1205） */
export const OPCODE = {
  NOOP: 0x00,
  INVITE: 0x01,
  OUTPUT_ONLY: 0x02,
  PUT_GET: 0x03,
  SAVE_SCREEN: 0x04,
  RESTORE_SCREEN: 0x05,
  READ_IMMEDIATE: 0x06,
  READ_SCREEN: 0x08,
  CANCEL_INVITE: 0x0a,
  MESSAGE_LIGHT_ON: 0x0b,
  MESSAGE_LIGHT_OFF: 0x0c
} as const;

/** ヘッダフラグ（1 バイト目）ビット（RFC 1205 の Flags。値は tn5250 record.h と一致） */
export const HDR_FLAG = {
  ERR: 0x80, // データストリーム出力エラー
  ATN: 0x40, // Attention キー
  SRQ: 0x04, // System Request キー
  TRQ: 0x02, // Test Request キー
  HLP: 0x01 // Help in Error State
} as const;

/** コマンド（ESC 0x04 に続く 1 バイト） */
export const ESC = 0x04;
export const COMMAND = {
  WRITE_TO_DISPLAY: 0x11,
  CLEAR_UNIT: 0x40,
  CLEAR_UNIT_ALTERNATE: 0x20,
  CLEAR_FORMAT_TABLE: 0x50,
  READ_INPUT_FIELDS: 0x42,
  READ_MDT_FIELDS: 0x52,
  READ_MDT_FIELDS_ALT: 0x82,
  READ_SCREEN: 0x62,
  WRITE_ERROR_CODE: 0x21,
  SAVE_SCREEN: 0x02,
  RESTORE_SCREEN: 0x12,
  ROLL: 0x23,
  WRITE_STRUCTURED_FIELD: 0xf3
} as const;

/** WTD オーダー */
export const ORDER = {
  SOH: 0x01, // Start of Header
  RA: 0x02, // Repeat to Address
  EA: 0x03, // Erase to Address
  TD: 0x10, // Transparent Data
  SBA: 0x11, // Set Buffer Address
  WEA: 0x12, // Write Extended Attribute
  IC: 0x13, // Insert Cursor
  MC: 0x14, // Move Cursor
  WDSF: 0x15, // Write to Display Structured Field
  SF: 0x1d // Start of Field
} as const;

/** AID コード（キーボード → ホスト） */
export const AID = {
  ENTER: 0xf1,
  F1: 0x31,
  F2: 0x32,
  F3: 0x33,
  F4: 0x34,
  F5: 0x35,
  F6: 0x36,
  F7: 0x37,
  F8: 0x38,
  F9: 0x39,
  F10: 0x3a,
  F11: 0x3b,
  F12: 0x3c,
  F13: 0xb1,
  F14: 0xb2,
  F15: 0xb3,
  F16: 0xb4,
  F17: 0xb5,
  F18: 0xb6,
  F19: 0xb7,
  F20: 0xb8,
  F21: 0xb9,
  F22: 0xba,
  F23: 0xbb,
  F24: 0xbc,
  CLEAR: 0xbd,
  HELP: 0xf3,
  PAGE_UP: 0xf4, // Roll Down
  PAGE_DOWN: 0xf5, // Roll Up
  PRINT: 0xf6,
  RECORD_BACKSPACE: 0xf8
} as const;

/** 属性バイトの範囲（0x20–0x3F。画面上 1 桁を占有する） */
export function isAttribute(byte: number): boolean {
  return byte >= 0x20 && byte <= 0x3f;
}

/** FFW（Field Format Word）ビット定義。上位バイトの 01xx xxxx が FFW 識別 */
export const FFW = {
  ID_MASK: 0xc000,
  ID_VALUE: 0x4000,
  BYPASS: 0x2000,
  DUP_ENABLE: 0x1000,
  MDT: 0x0800,
  SHIFT_MASK: 0x0700,
  SHIFT_ALPHA: 0x0000,
  SHIFT_ALPHA_ONLY: 0x0100,
  SHIFT_NUMERIC_SHIFT: 0x0200,
  SHIFT_NUMERIC_ONLY: 0x0300,
  SHIFT_KATAKANA: 0x0400,
  SHIFT_DIGITS_ONLY: 0x0500,
  SHIFT_IO: 0x0600,
  SHIFT_SIGNED_NUMERIC: 0x0700,
  AUTO_ENTER: 0x0080,
  FIELD_EXIT_REQUIRED: 0x0040,
  MONOCASE: 0x0020,
  MANDATORY_ENTER: 0x0008,
  ADJUST_MASK: 0x0007,
  ADJUST_RIGHT_ZERO: 0x0005,
  ADJUST_RIGHT_BLANK: 0x0006,
  ADJUST_MANDATORY_FILL: 0x0007
} as const;
