/**
 * telnet の定数（RFC 854 / RFC 1576）。
 *
 * **合意するオプションは 3 つだけ**——TERMINAL-TYPE / END-OF-RECORD / BINARY。
 * 5250（`@ts5250/tn5250`）が使う SGA(3) と NEW-ENVIRON(39) は **3270 では出てこない**
 * （research F2: Hercules 実測。RFC 1576 の記載とも一致）。
 */
export const IAC = 0xff;

export const CMD = {
  SE: 0xf0,
  SB: 0xfa,
  WILL: 0xfb,
  WONT: 0xfc,
  DO: 0xfd,
  DONT: 0xfe,
  /** レコード境界（IAC EOR = FF EF） */
  EOR: 0xef
} as const;

export const OPT = {
  BINARY: 0x00,
  TERMINAL_TYPE: 0x18,
  END_OF_RECORD: 0x19
} as const;

/** TERMINAL-TYPE サブネゴシエーション（RFC 1091） */
export const TT_IS = 0x00;
export const TT_SEND = 0x01;
