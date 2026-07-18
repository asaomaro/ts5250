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
 * 2 バイト固定の変換部。
 *
 * EBCDIC_STATEFUL の「SO モード側」と、純 DBCS（uconv_class "DBCS"）は**同じ形**なので
 * 型を共有する。混在 CCSID（930/939/1399）では StatefulTable.dbcs として、
 * 純 DBCS CCSID（16684/300。SQL の GRAPHIC 列）では PureDbcsTable.part として使う。
 */
export interface DbcsPart {
  /** (b1<<8 | b2) → Unicode コードポイント */
  readonly ebcdicToUnicode: ReadonlyMap<number, number>;
  /** Unicode コードポイント → (b1<<8 | b2) */
  readonly unicodeToEbcdic: ReadonlyMap<number, number>;
  /** 2 バイト置換（DBCS SUB。930 系は 0xFEFE） */
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
  readonly dbcs: DbcsPart;
}

/**
 * 純 DBCS テーブル（uconv_class "DBCS"。mb_cur_min = mb_cur_max = 2）。
 * SO/SI を持たず、常に 2 バイトで 1 文字。SQL の GRAPHIC / VARGRAPHIC 列が使う。
 */
export interface PureDbcsTable {
  readonly ccsid: number;
  readonly name: string;
  readonly part: DbcsPart;
}
