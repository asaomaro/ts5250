/** telnet のコマンド（RFC 854） */
export const IAC = 255;
export const CMD = {
  SE: 240,
  NOP: 241,
  DM: 242,
  BRK: 243,
  IP: 244,
  AO: 245,
  AYT: 246,
  EC: 247,
  EL: 248,
  GA: 249,
  SB: 250,
  WILL: 251,
  WONT: 252,
  DO: 253,
  DONT: 254
} as const;

/** telnet のオプション */
export const OPT = {
  BINARY: 0,       // RFC 856
  ECHO: 1,         // RFC 857
  SGA: 3,          // RFC 858
  STATUS: 5,
  TERMINAL_TYPE: 24, // RFC 1091
  EOR: 25,
  NAWS: 31,        // RFC 1073
  TERMINAL_SPEED: 32,
  LINEMODE: 34,    // RFC 1184
  XDISPLOC: 35,
  NEW_ENVIRON: 39  // RFC 1572
} as const;

export const TTYPE_IS = 0;
export const TTYPE_SEND = 1;

export const ENV_IS = 0;
export const ENV_SEND = 1;
export const ENV_VAR = 0;
export const ENV_VALUE = 1;
export const ENV_USERVAR = 3;

export const OPTION_NAMES: Readonly<Record<number, string>> = {
  0: "BINARY",
  1: "ECHO",
  3: "SGA",
  5: "STATUS",
  24: "TERMINAL-TYPE",
  25: "EOR",
  31: "NAWS",
  32: "TERMINAL-SPEED",
  34: "LINEMODE",
  35: "XDISPLOC",
  39: "NEW-ENVIRON"
};

export const optionName = (n: number): string => OPTION_NAMES[n] ?? `opt${n}`;
