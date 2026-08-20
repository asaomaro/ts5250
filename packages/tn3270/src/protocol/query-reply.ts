import { ByteWriter } from "./bytes.js";
import { alternateSizeFor, PRIMARY_SIZE, type Model3270 } from "../telnet/terminal-type.js";

/**
 * 構造化フィールドの Query / Query Reply。
 *
 * ## なぜ要るか
 *
 * **IBM i は接続直後に Query を撃ち、応答を待ってから画面を出す**（実測）。
 * 応答しないと画面が来ないまま止まる——実際、これを実装せずに pub400 へ繋いだら
 * 交渉だけ成功して沈黙した。Hercules（MVS 3.8j）は Query を撃ってこないので、
 * TK4- だけで検証していた間は必要性に気づけなかった。
 *
 * ## 受信側（Query）
 *
 * IBM i が送ってきた実バイト（telnet の二重化を解いた後）:
 * ```
 * 11 00 00 01 ff 02
 * ^^ WSF(SNA 系)
 *    ^^^^^ 長さ 0（＝レコード末尾まで）
 *          ^^ type=01 Read Partition
 *             ^^ パーティション 0xff（全体）
 *                ^^ opcode=02 Query
 * ```
 *
 * ## 送信側（Query Reply）
 *
 * `AID(0x88)` に続けて `LL LL 81 <種別> <データ>` を並べる。
 * 種別と中身は **s3270 が同じホストへ返したものを実測**して決めた
 * （`artifacts/ibmi.trc`）。**申告するのは実際に持っている機能だけ**にする——
 * 無い機能を申告すると、ホストがそれを前提にしたデータを送ってくる。
 */

/**
 * 構造化フィールドの種別（実測。s3270 の復号名と突き合わせて確定）。
 *
 * IBM i は **1 レコードに複数の SF を詰めてくる**——画面本体（`OUTBOUND_3270DS`）の後ろに
 * `SET_REPLY_MODE` が続く、という形を実測した。**全部を走査しないと後半を取りこぼす。**
 */
export const SF_TYPE = {
  /** Read Partition（Query 要求がここに入る） */
  READ_PARTITION: 0x01,
  /** Set Reply Mode。こちらから返すものは無い */
  SET_REPLY_MODE: 0x09,
  /** **Outbound 3270DS**——通常のデータストリームを包む封筒。中身を展開して適用する */
  OUTBOUND_3270DS: 0x40,
  /** 端末 → ホストの Query Reply */
  QUERY_REPLY: 0x81
} as const;

/** Read Partition の opcode */
export const RP_OP = {
  QUERY: 0x02,
  QUERY_LIST: 0x03
} as const;

/** Query Reply の種別（実測で s3270 が返していたもののうち、こちらが実装している範囲） */
export const QR = {
  SUMMARY: 0x80,
  USABLE_AREA: 0x81,
  ALPHANUMERIC_PARTITIONS: 0x84,
  CHARACTER_SETS: 0x85,
  COLOR: 0x86,
  HIGHLIGHTING: 0x87,
  IMPLICIT_PARTITION: 0xa6
} as const;

/** 端末 → ホストの構造化フィールド応答に使う AID（実測: s3270 が 0x88 で始めていた） */
export const AID_STRUCTURED_FIELD = 0x88;

/** レコードから切り出した 1 つの構造化フィールド */
export interface StructuredField {
  type: number;
  /** 種別に続く中身（`LL LL type` を除いた部分） */
  body: Uint8Array;
}

/**
 * `Write Structured Field` レコードを構造化フィールドの列に分解する。
 *
 * **長さ 0 は「レコード末尾まで」**（実測: IBM i の Query は `11 00 00 01 ff 02` で
 * 長さ 0 を使ってくる）。
 */
export function splitStructuredFields(record: Uint8Array): StructuredField[] {
  const out: StructuredField[] = [];
  let i = 1; // record[0] はコマンド
  while (i + 3 <= record.length) {
    const len = (record[i]! << 8) | record[i + 1]!;
    const end = len === 0 ? record.length : i + len;
    if (end <= i + 2 || end > record.length) break; // 壊れている
    out.push({ type: record[i + 2]!, body: record.subarray(i + 3, end) });
    i = end;
  }
  return out;
}

export interface QueryRequest {
  kind: "query" | "query-list";
  partition: number;
}

/** Read Partition の中身が Query 要求ならそれを返す */
export function asQueryRequest(sf: StructuredField): QueryRequest | null {
  if (sf.type !== SF_TYPE.READ_PARTITION) return null;
  const op = sf.body[1];
  const partition = sf.body[0] ?? 0xff;
  if (op === RP_OP.QUERY) return { kind: "query", partition };
  if (op === RP_OP.QUERY_LIST) return { kind: "query-list", partition };
  return null;
}

export interface QueryReplyOptions {
  model?: Model3270;
  /** 拡張属性（色・ハイライト）を申告するか。3278 系なら false */
  extendedAttributes?: boolean;
  /**
   * **DBCS 対応を申告するか。**
   *
   * 日本語 IBM i は、DBCS を申告しないと**画面を出さずに黙る**（実測）。
   * 英語ホスト（pub400 / MVS 3.8j）は申告の有無にかかわらず画面を出すので、
   * TK4- と pub400 だけで試していた間はこの必要性に気づけなかった。
   */
  dbcs?: boolean;
}

/**
 * Query Reply を組み立てる。
 *
 * **申告する範囲**: Summary / UsableArea / AlphanumericPartitions / CharacterSets /
 * ImplicitPartition ＋（拡張属性ありなら）Color / Highlighting。
 * DDM・RPQ Names・Reply Modes は**実装していないので申告しない**。
 */
export function buildQueryReply(opts: QueryReplyOptions = {}): Uint8Array {
  const model = opts.model ?? 2;
  const ext = opts.extendedAttributes ?? true;
  const alt = alternateSizeFor(model);

  const kinds: number[] = [
    QR.SUMMARY,
    QR.USABLE_AREA,
    QR.ALPHANUMERIC_PARTITIONS,
    QR.CHARACTER_SETS,
    ...(ext ? [QR.COLOR, QR.HIGHLIGHTING] : []),
    QR.IMPLICIT_PARTITION
  ];

  const w = new ByteWriter();
  w.u8(AID_STRUCTURED_FIELD);

  // Summary: 以降に並ぶ Query Reply の種別を列挙する
  sf(w, [QR.SUMMARY, ...kinds]);

  // UsableArea: 画面の使える広さ。**代替サイズで申告する**（EW/EWA どちらも受けられるように）
  sf(w, [
    QR.USABLE_AREA,
    0x01, // 12/14 ビットアドレス・可変長
    0x00,
    (alt.cols >> 8) & 0xff,
    alt.cols & 0xff,
    (alt.rows >> 8) & 0xff,
    alt.rows & 0xff,
    0x01, // 単位: インチ
    0x00, 0x0a, 0x02, 0xe5, // Xr
    0x00, 0x02, 0x00, 0x6f, // Yr
    0x09, // AW
    0x0c, // AH
    ((alt.rows * alt.cols) >> 8) & 0xff,
    (alt.rows * alt.cols) & 0xff
  ]);

  // AlphanumericPartitions: パーティションは 1 つだけ
  sf(w, [QR.ALPHANUMERIC_PARTITIONS, 0x00, (alt.rows * alt.cols) >> 8, (alt.rows * alt.cols) & 0xff, 0x00]);

  // CharacterSets: 使える文字セットの申告。
  //
  // **DBCS の申告がここに要る**（実測）。日本語 IBM i は DBCS 記述子が無いと画面を出さない。
  // 記述子の中身は s3270 が同じホストへ返したものを解析して得た（`artifacts/osaka-qr`）:
  //   1) SBCS 基本セット   CGCSGID = 1172 / 290（日本語 SBCS）
  //   2) DBCS セット       CGCSGID =  963 / 310（日本語 DBCS）
  //   3) 純 DBCS セット    CGCSGID =  370 / 300、**SW=18（全角セル）** / FLAGS=0x20（DBCS）
  if (opts.dbcs === true) {
    sf(w, [
      QR.CHARACTER_SETS,
      0x8e, // GE 可 ＋ DBCS 有り
      0x00,
      0x09, 0x0c, // 既定のセル寸法 SDW=9 / SDH=12
      0x00, 0x00, 0x00, 0x00, // FORM
      0x0b, // 記述子 1 件は 11 バイト（DBCS 有りだと SW/SH と CGCSGID が付く）
      // SET, FLAGS, LCID, SW, SH, SUBSN(2), CGCSGID(4)
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x04, 0x94, 0x01, 0x22,
      0x01, 0x00, 0xf1, 0x00, 0x00, 0x00, 0x00, 0x03, 0xc3, 0x01, 0x36,
      0x80, 0x20, 0xf8, 0x12, 0x0c, 0x41, 0x7f, 0x01, 0x72, 0x01, 0x2c
    ]);
  } else {
    sf(w, [
      QR.CHARACTER_SETS,
      0x82, // GE 可・ロード不可
      0x00,
      0x09, 0x0c,
      0x00, 0x00, 0x00, 0x00,
      0x07, // 記述子 1 件は 7 バイト
      0x00, 0x10, 0x00, 0x00, 0x00, 0x00, 0x00
    ]);
  }

  if (ext) {
    // Color: 8 色（既定 + 7 色）。値は実測した COLOR の割り当てに合わせる
    sf(w, [
      QR.COLOR,
      0x00,
      0x08,
      0x00, 0xf4, // 既定 → 緑
      0xf1, 0xf1, 0xf2, 0xf2, 0xf3, 0xf3, 0xf4, 0xf4,
      0xf5, 0xf5, 0xf6, 0xf6, 0xf7, 0xf7
    ]);
    // Highlighting: blink / reverse / underscore
    sf(w, [
      QR.HIGHLIGHTING,
      0x04,
      0x00, 0xf0, // 既定 → normal
      0xf1, 0xf1,
      0xf2, 0xf2,
      0xf4, 0xf4
    ]);
  }

  // ImplicitPartition: 標準サイズと代替サイズを申告する。
  //
  // **4 つとも 2 バイトで書く。** 自己定義パラメータの長さ `0x0b` は
  // 「LL(1) + ID(1) + FLAGS(1) + 幅高さ 4 つ × 2 バイト」の 11。標準サイズだけ
  // 1 バイトで書くと後続が 1 桁ずつずれ、**ホストは代替幅を 24 桁と読む**
  // （実測: TK4- の TSO が行モードの出力を 24 桁で折り、
  //  `IKJ56714A ENTER CURRENT` ＋ `***` に切れた）
  sf(w, [
    QR.IMPLICIT_PARTITION,
    0x00, 0x00,
    0x0b, 0x01, 0x00,
    (PRIMARY_SIZE.cols >> 8) & 0xff, PRIMARY_SIZE.cols & 0xff,
    (PRIMARY_SIZE.rows >> 8) & 0xff, PRIMARY_SIZE.rows & 0xff,
    (alt.cols >> 8) & 0xff, alt.cols & 0xff,
    (alt.rows >> 8) & 0xff, alt.rows & 0xff
  ]);

  return w.toUint8Array();
}

/** `LL LL 81 <body>` を書く（LL は自身を含む長さ） */
function sf(w: ByteWriter, body: readonly number[]): void {
  const len = body.length + 3; // LL(2) + 0x81
  w.u16(len).u8(SF_TYPE.QUERY_REPLY).bytes(body);
}
