/**
 * QGY のオープンリスト API に共通する部分。
 *
 * スプール一覧（`QGYOLSPL`）で確立した手順を、ジョブ・オブジェクト一覧でも使う。
 * どの API も「受信変数 ＋ リスト情報(80) ＋ 形式名 ＋ エラーコード」という骨格を持つ。
 *
 * 参照: JTOpen(jtopenlite) の command/program/openlist に対応する。
 */
import { As400Error } from "../../errors.js";
import { codecForCcsid, type Codec } from "../../codec/codec.js";
import type { CommandConnection } from "../command/command-connection.js";
import type { ProgramParameter } from "../command/command-datastream.js";

const EBCDIC_CCSID = 37;
const EBCDIC_SPACE = 0x40;
const codec = codecForCcsid(EBCDIC_CCSID);

/** リスト情報（80 バイト）の項目位置 */
const LIST_INFO = { total: 0, returned: 4, handle: 8, recordLength: 12 } as const;

/** CCSID 37 の EBCDIC で固定長・空白詰め */
export function padEbcdic(text: string, length: number): Uint8Array {
  const out = new Uint8Array(length).fill(EBCDIC_SPACE);
  const { bytes, substituted } = codec.encode(text.toUpperCase());
  if (substituted > 0) {
    throw new As400Error(
      "CONFIG_ERROR",
      `"${text}" contains characters not representable in CCSID ${EBCDIC_CCSID}`
    );
  }
  out.set(bytes.subarray(0, length));
  return out;
}

/** EBCDIC の断片を文字列にする（末尾の空白は落とす）。codec 省略時は CCSID 37 */
export function readEbcdic(
  data: Uint8Array,
  at: number,
  length: number,
  with_ = codec
): string {
  return with_.decode(data.subarray(at, at + length)).trimEnd();
}

/**
 * ホストサーバージョブの CCSID に対応するコーデック。
 *
 * **リストが返す文字は CCSID 37 ではなくジョブの CCSID で入っている。** 日本語機では
 * ユーザーの説明などが DBCS（SO/SI ＋ 2 バイト）で返るので、37 で読むと 1 バイトずつ
 * ラテン文字に化ける（実機のユーザー一覧で「ä[äbäýäþ」のように出た）。
 * 未対応の CCSID なら 37 のまま——読めない値で落とすより従来どおり出す方が害が小さい。
 */
export function codecOf(conn: CommandConnection): Codec {
  const ccsid = conn?.info?.ccsid;
  if (!ccsid || ccsid === EBCDIC_CCSID) return codec;
  try {
    return codecForCcsid(ccsid);
  } catch {
    return codec;
  }
}

/** 4 バイト整数 */
export function int32(value: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setInt32(0, value);
  return b;
}

/** バイト列を連結する */
export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

/** リスト情報（80 バイト）の解釈 */
export interface ListInfo {
  /**
   * **構築されたリストの件数**＝`min(要求件数, 実際の一致件数)`。
   * 「条件に一致した総件数」**ではない**——要求件数がリストの構築量そのものを決めるため、
   * 要求件数で頭打ちになる（QGYOLSPL に対する実測。`spool/spool-list.ts` の LIST_INFO 参照）。
   * よって**打ち切り判定に使ってはいけない**（常に `total == returned` になり偽陰性になる）。
   */
  total: number;
  /** 今回返ってきた件数 */
  returned: number;
  /** 1 レコードのバイト数 */
  recordLength: number;
}

export function parseListInfo(data: Uint8Array): ListInfo {
  if (data.length < 16) {
    throw new As400Error("PROTOCOL_ERROR", `list information too short: ${data.length} bytes`);
  }
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    total: v.getInt32(LIST_INFO.total),
    returned: v.getInt32(LIST_INFO.returned),
    recordLength: v.getInt32(LIST_INFO.recordLength)
  };
}

/**
 * オープンリスト API を呼び、レコードを切り出す。
 *
 * @param decode 1 レコードを解釈する関数
 */
export async function callOpenList<T>(
  conn: CommandConnection,
  program: string,
  library: string,
  params: readonly ProgramParameter[],
  opts: {
    receiveIndex: number;
    listInfoIndex: number;
    decode: (record: Uint8Array, textCodec: Codec) => T;
    /** 空レコードで打ち切るか（既定 true）。0 埋めの余白を件数に数えないため */
    stopAtEmpty?: boolean;
  }
): Promise<T[]> {
  const { result, outputs } = await conn.call(program, library, params);
  if (!result.success) {
    const primary = result.messages.find((m) => m.kind === "error" || m.kind === "severe");
    throw new As400Error(
      "COMMAND_FAILED",
      `${program} failed${primary ? `: ${primary.id} ${primary.text}` : ""}`
    );
  }

  const listInfo = outputs[opts.listInfoIndex];
  const records = outputs[opts.receiveIndex];
  if (!listInfo || !records) {
    throw new As400Error("PROTOCOL_ERROR", `${program} returned no list information`);
  }
  const textCodec = codecOf(conn);
  const info = parseListInfo(listInfo);
  if (info.recordLength <= 0) return [];

  /*
   * **サーバーが申告する件数を鵜呑みにしない。**
   *
   * 受信変数に入りきらなくても `returned` には全件数が入ることがある
   * （実機で「248 件返した」と言いながら受信変数 8192 バイト・レコード長 62 で
   *  132 件分しか無い、という状態を観測した）。
   * 入りきる件数で打ち切り、足りなければ呼び出し側が受信変数を増やす。
   */
  const fits = Math.floor(records.length / info.recordLength);
  const count = Math.min(info.returned, fits);
  const stopAtEmpty = opts.stopAtEmpty ?? true;

  const out: T[] = [];
  for (let i = 0; i < count; i++) {
    const at = i * info.recordLength;
    const record = records.subarray(at, at + info.recordLength);
    // 受信変数の余白は 0 埋め。全 0 のレコードは実データの終端とみなす
    if (stopAtEmpty && record.every((b) => b === 0)) break;
    out.push(opts.decode(record, textCodec));
  }
  return out;
}
