/**
 * telnet の定数（RFC 854 / RFC 1576 / RFC 1572）。
 *
 * **素の 3270 ホストが使うのは 3 つ**——TERMINAL-TYPE / END-OF-RECORD / BINARY
 * （research F2: Hercules 実測。RFC 1576 の記載とも一致。SGA は出てこない）。
 *
 * **ただし IBM i は NEW-ENVIRON も送ってくる**（5250 と同じ telnet サーバーのため）。
 * これに応じてコードページを申告しないと variant 文字が化ける（`OPT.NEW_ENVIRON` 参照）。
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
  END_OF_RECORD: 0x19,
  /**
   * NEW-ENVIRON（RFC 1572）。**素の 3270 ホストは使わないが IBM i は送ってくる。**
   *
   * IBM i に対しては**申告しないと variant 文字が化ける**——ホストはシステム既定の
   * コードページで仮想デバイスを作るため、こちらが CCSID 37 で送った `'@'`(0x7C) を
   * 別の文字として読む。5250 側に実例の記録がある（PUB400 は QCCSID=273 で
   * `'@'` が `'§'` になり、`'@'` 入りパスワードが CPF1120 で落ちる）。
   */
  NEW_ENVIRON: 0x27,
  /**
   * TN3270E（RFC 2355）。**サーバから `DO` で提示される**（§13.2）。
   *
   * 提示するホストとは TN3270E で、提示しないホストとは基本 TN3270 で繋ぐ。
   * 実測では TK4-（MVS 3.8j）も IBM i も提示しない——**z/OS 向けの経路**。
   */
  TN3270E: 0x28
} as const;

/** NEW-ENVIRON サブネゴシエーション（RFC 1572） */
export const ENV_IS = 0;
export const ENV_SEND = 1;
export const ENV_VAR = 0;
export const ENV_VALUE = 1;
export const ENV_USERVAR = 3;

/** TERMINAL-TYPE サブネゴシエーション（RFC 1091） */
export const TT_IS = 0x00;
export const TT_SEND = 0x01;
