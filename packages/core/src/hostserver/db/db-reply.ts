/**
 * database の応答パラメータ（列定義・結果データ・SQLCA）の解析。
 *
 * 参照: JTOpen(jtopenlite) の DatabaseConnection.parseReply の
 *       CP 0x3812 / 0x380E / 0x3807 の処理に対応する。
 */
import { As400Error } from "../../errors.js";
import { codecForCcsid } from "../../codec/codec.js";
import { toColumnMeta, type ColumnMeta } from "./db-decode.js";

/**
 * 列定義 1 件あたりの固定長（DBOriginalDataFormat）。
 *
 * 実機（IBM i 7.5）は `prepareAndDescribe` に拡張列記述子を要求しても
 * **CP 0x3805 の元形式**で返してくる。原典の DBOriginalDataFormat と一致し、
 * 型・長さ・位取り・精度・CCSID・列名がすべて含まれるため、この形式で解析する。
 *
 * 検証: 2 列（SMALLINT, CHAR(10)）の応答が 116 バイト = 8 + 2×54 と一致した。
 */
const FIELD_DESC_LEN = 54;
/** ヘッダー部（整合性トークン 4 ＋ 列数 2 ＋ レコード長 2） */
const FORMAT_HEADER_LEN = 8;
/**
 * 結果データのヘッダー部（元形式 CP 0x3806）。
 * 拡張形式（0x380E）は 20 バイトだが、実機は元形式で返すため 14。
 * 内訳: 整合性トークン4 ＋ 行数4 ＋ 列数2 ＋ 指標サイズ2 ＋ 行サイズ2
 */
const RESULT_HEADER_LEN = 14;
/** 資格情報と同じく、SQLSTATE も CCSID 37 で読む */
const SQLCA_CCSID = 37;

/** 列定義内の相対オフセット（原典 DBOriginalDataFormat の getter に対応） */
const F = {
  type: 2,
  length: 4,
  scale: 6,
  precision: 8,
  ccsid: 10,
  nameLength: 20,
  nameCcsid: 22,
  name: 24
} as const;

export interface ResultFormat {
  columns: ColumnMeta[];
  /** 1 行のバイト数 */
  recordSize: number;
}

/**
 * 列定義（CP 0x3805）を解析する。
 *
 * **行内オフセットは応答に含まれない**——列の長さを順に足して求める
 * （原典も `offset_ += length` で累積している）。
 */
export function parseDataFormat(value: Uint8Array): ResultFormat {
  if (value.length < FORMAT_HEADER_LEN) {
    throw new As400Error("PROTOCOL_ERROR", `data format too short: ${value.length} bytes`);
  }
  const v = new DataView(value.buffer, value.byteOffset, value.byteLength);
  const numFields = v.getUint16(4);
  const recordSize = v.getUint16(6);

  const need = FORMAT_HEADER_LEN + FIELD_DESC_LEN * numFields;
  if (value.length < need) {
    throw new As400Error(
      "PROTOCOL_ERROR",
      `data format declares ${numFields} fields (needs ${need} bytes) but only ${value.length} available`
    );
  }

  const columns: ColumnMeta[] = [];
  let offset = 0;
  for (let i = 0; i < numFields; i++) {
    const at = FORMAT_HEADER_LEN + FIELD_DESC_LEN * i;
    const type = v.getUint16(at + F.type);
    const length = v.getUint16(at + F.length);
    const ccsid = v.getUint16(at + F.ccsid);
    columns.push(
      toColumnMeta({
        name: readFieldName(value, at) ?? `COL${i + 1}`,
        type,
        offset,
        length,
        scale: v.getInt16(at + F.scale),
        precision: v.getInt16(at + F.precision),
        ccsid
      })
    );
    offset += length;
  }
  return { columns, recordSize };
}

/**
 * 列名。列定義内に長さ・CCSID とともに埋め込まれている。
 * 読めない場合は undefined を返し、既定名にフォールバックする（名前で解析全体を落とさない）。
 */
function readFieldName(value: Uint8Array, fieldAt: number): string | undefined {
  const v = new DataView(value.buffer, value.byteOffset, value.byteLength);
  const len = v.getUint16(fieldAt + F.nameLength);
  if (len === 0) return undefined;
  const at = fieldAt + F.name;
  if (at + len > value.length) return undefined;
  const ccsid = v.getUint16(fieldAt + F.nameCcsid);
  const bytes = value.subarray(at, at + len);
  try {
    return codecForCcsid(ccsid === 0 || ccsid === 65535 ? SQLCA_CCSID : ccsid)
      .decode(bytes)
      .trimEnd();
  } catch {
    return codecForCcsid(SQLCA_CCSID).decode(bytes).trimEnd();
  }
}

export interface ResultData {
  rowCount: number;
  columnCount: number;
  /** 行ごと・列ごとの NULL 指標 */
  nulls: boolean[][];
  /** 行ごとの生バッファ */
  rows: Uint8Array[];
}

/**
 * 拡張結果データ（CP 0x380E）を解析する。
 *
 * **NULL 指標がすべて先に並び、その後に行データが続く**（行ごとに交互ではない）。
 * 指標は 1 つ `indicatorSize` バイトで、**-1 が NULL**。
 * `indicatorSize` が 0 のときは指標そのものが無い（NULL 可の列が無い場合）。
 *
 * NULL の列も行バッファ上は場所を占める（空白等で埋まる）。値の有無は指標だけで判断する。
 */
export function parseResultData(value: Uint8Array): ResultData {
  if (value.length < RESULT_HEADER_LEN) {
    throw new As400Error("PROTOCOL_ERROR", `result data too short: ${value.length} bytes`);
  }
  const v = new DataView(value.buffer, value.byteOffset, value.byteLength);
  const rowCount = v.getInt32(4);
  const columnCount = v.getInt16(8);
  const indicatorSize = v.getInt16(10);
  const rowSize = v.getUint16(12);

  let pos = RESULT_HEADER_LEN;
  const nulls: boolean[][] = [];
  for (let r = 0; r < rowCount; r++) {
    const rowNulls: boolean[] = [];
    for (let c = 0; c < columnCount; c++) {
      if (indicatorSize <= 0) {
        rowNulls.push(false);
        continue;
      }
      if (pos + indicatorSize > value.length) {
        throw new As400Error("PROTOCOL_ERROR", "result data truncated while reading indicators");
      }
      // 指標は符号付き。-1 が NULL
      rowNulls.push(v.getInt16(pos) === -1);
      pos += indicatorSize;
    }
    nulls.push(rowNulls);
  }

  const rows: Uint8Array[] = [];
  for (let r = 0; r < rowCount; r++) {
    if (pos + rowSize > value.length) break; // 宣言より少ない行しか来ない場合がある
    rows.push(value.subarray(pos, pos + rowSize));
    pos += rowSize;
  }

  return { rowCount: rows.length, columnCount, nulls, rows };
}

export interface Sqlca {
  sqlCode: number;
  sqlState: string;
  updateCount: number;
}

/** SQLCA（CP 0x3807）。SQLCODE と SQLSTATE の位置は固定 */
export function parseSqlca(value: Uint8Array): Sqlca | undefined {
  if (value.length < 136) return undefined;
  const v = new DataView(value.buffer, value.byteOffset, value.byteLength);
  return {
    sqlCode: v.getInt32(12),
    updateCount: v.getInt32(104),
    sqlState: codecForCcsid(SQLCA_CCSID).decode(value.subarray(131, 136))
  };
}
