/** telnet プロトコル定数（RFC 854/855/1091/1572/1205/4777） */
export const IAC = 0xff;
export const CMD = {
  SE: 0xf0,
  SB: 0xfa,
  WILL: 0xfb,
  WONT: 0xfc,
  DO: 0xfd,
  DONT: 0xfe,
  EOR: 0xef
} as const;

export const OPT = {
  BINARY: 0,
  SGA: 3,
  TERMINAL_TYPE: 24,
  EOR: 25,
  NEW_ENVIRON: 39
} as const;

/** TERMINAL-TYPE サブネゴシエーション（RFC 1091） */
export const TT_IS = 0;
export const TT_SEND = 1;

/** NEW-ENVIRON サブネゴシエーション（RFC 1572） */
export const ENV_IS = 0;
export const ENV_SEND = 1;
export const ENV_VAR = 0;
export const ENV_VALUE = 1;
export const ENV_ESC = 2;
export const ENV_USERVAR = 3;
