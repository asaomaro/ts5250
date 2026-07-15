/**
 * gen-tables が生成する変換テーブルの型（spec D2）。
 * SBCS: EBCDIC 1 バイト ⇔ Unicode コードポイント。
 */
export interface SbcsTable {
  readonly ccsid: number;
  /** .ucm の code_set_name（生成元の識別用） */
  readonly name: string;
  /** EBCDIC バイト(0-255) → Unicode コードポイント。未定義は U+FFFD */
  readonly ebcdicToUnicode: Uint16Array;
  /** Unicode コードポイント → EBCDIC バイト */
  readonly unicodeToEbcdic: ReadonlyMap<number, number>;
  /** 置換文字（SUB）。ibm-37 系は 0x3F */
  readonly sub: number;
}

/**
 * EBCDIC_STATEFUL（DBCS）テーブル（ibm-930/939/1399）。
 * SBCS 部（SI モード・1 バイト）と DBCS 部（SO モード・2 バイト）を持つ。
 */
export interface StatefulTable {
  readonly ccsid: number;
  readonly name: string;
  /** SBCS 部（SI モード。1 バイト ⇔ Unicode） */
  readonly sbcs: SbcsTable;
  /** DBCS 部（SO モード。2 バイト ⇔ Unicode） */
  readonly dbcs: {
    /** (b1<<8 | b2) → Unicode コードポイント */
    readonly ebcdicToUnicode: ReadonlyMap<number, number>;
    /** Unicode コードポイント → (b1<<8 | b2) */
    readonly unicodeToEbcdic: ReadonlyMap<number, number>;
    /** 2 バイト置換（DBCS SUB。930 系は 0xFEFE） */
    readonly sub: number;
  };
}
