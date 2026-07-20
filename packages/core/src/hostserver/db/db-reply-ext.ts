/**
 * 超拡張データ形式（CP `0x3812`）と拡張結果データ（CP `0x380E`）の解析。
 *
 * **元形式（`0x3805` / `0x3806`）とは構造が根本的に違う**ので別ファイルにしている。
 * 元形式のパーサー（`db-reply.ts`）は残してある——`0xF2` を受け付けないホストが
 * 見つかったときに戻せるようにするため（現在 IBM i 7.5 の 1 台でしか検証していない）。
 *
 * この形式を使うと **LOB 列を含む結果セットが扱える**ようになる。
 * 元形式のままだと、ホストが prepare の段階で `rcClass=7, code=-101` を返して
 * 列定義を一切よこさない（LOB を含む表では `SELECT *` が通らなかった原因）。
 *
 * 参照: JTOpen 本体の `DBSuperExtendedDataFormat` / `DBExtendedData`
 * （逐語移植ではなく、バイト配置という事実に基づく書き起こし）。
 */
import { As400Error } from "../../errors.js";
import { codecForCcsid } from "../../codec/codec.js";

/** 列定義の固定部の長さ */
const FIXED_LEN = 16;
/** 列 1 つあたりの繰り返し部の長さ */
const REPEATED_LEN = 48;
/** 可変長情報のうち列名を運ぶコードポイント */
const CP_FIELD_NAME = 0x3840;

export interface ExtColumn {
  name: string;
  /** SQL の型コード（NULL 可を示す +1 を含む生の値） */
  sqlType: number;
  length: number;
  scale: number;
  precision: number;
  ccsid: number;
  /** レコードバッファ内の開始位置 */
  offset: number;
  /** **0 以外なら LOB**。ロケーターのハンドル */
  lobLocator: number;
  lobMaxSize: number;
}

export interface ExtResultFormat {
  columns: ExtColumn[];
  recordSize: number;
}

/**
 * 超拡張列定義（CP `0x3812`）を解析する。
 *
 * **列のバッファ内オフセットは形式に含まれない**ので、長さを積み上げて求める
 * （元形式も同じ考え方）。
 */
export function parseSuperExtendedDataFormat(value: Uint8Array): ExtResultFormat {
  if (value.length < FIXED_LEN) {
    throw new As400Error(
      "PROTOCOL_ERROR",
      `super extended data format too short: ${value.length} bytes`
    );
  }
  const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
  const fieldCount = view.getUint32(4);
  const recordSize = view.getUint32(12);
  const columns: ExtColumn[] = [];
  let offset = 0;

  for (let i = 0; i < fieldCount; i++) {
    const base = FIXED_LEN + i * REPEATED_LEN;
    if (base + REPEATED_LEN > value.length) {
      throw new As400Error(
        "PROTOCOL_ERROR",
        `super extended data format truncated at column ${i} (${value.length} bytes)`
      );
    }
    const sqlType = view.getUint16(base + 2);
    const length = view.getUint32(base + 4);
    const scale = view.getUint16(base + 8);
    const precision = view.getUint16(base + 10);
    const ccsid = view.getUint16(base + 12);
    const lobLocator = view.getUint32(base + 17);
    const lobMaxSize = view.getUint32(base + 26);
    columns.push({
      name: readFieldName(value, view, i),
      sqlType,
      length,
      scale,
      precision,
      ccsid,
      offset,
      lobLocator,
      lobMaxSize
    });
    offset += length;
  }
  return { columns, recordSize };
}

/**
 * 列名は可変長部にある。`LL(4) CP(2) 名前CCSID(2) 名前…` が並び、
 * CP `0x3840` が列名。名前の長さは `LL - 8`。
 *
 * **見つからなければ空文字にする**（例外にしない）——式や関数の結果列には
 * 名前が無いことがあり、それは異常ではない。
 */
function readFieldName(value: Uint8Array, view: DataView, index: number): string {
  const base = FIXED_LEN + index * REPEATED_LEN;
  try {
    const toVariable = view.getUint32(base + 32);
    const variableTotal = view.getUint32(base + 36);
    let pos = base + toVariable;
    let read = 0;
    while (read < variableTotal && pos + 8 <= value.length) {
      const ll = view.getUint32(pos);
      if (ll < 8) break;
      const cp = view.getUint16(pos + 4);
      if (cp === CP_FIELD_NAME) {
        const nameCcsid = view.getUint16(pos + 6);
        const nameLen = ll - 8;
        if (nameLen <= 0 || pos + 8 + nameLen > value.length) return "";
        const bytes = value.subarray(pos + 8, pos + 8 + nameLen);
        // 名前の CCSID は通常ジョブの CCSID。未知なら 37 で読む
        return codecForCcsid(nameCcsid || 37).decode(bytes).trim();
      }
      pos += ll;
      read += ll;
    }
  } catch {
    // 可変長部の解析失敗で列そのものを落とさない（名前は付加情報）
    return "";
  }
  return "";
}

export interface ExtResultData {
  /** 行ごとの生バイト列 */
  rows: Uint8Array[];
  /** 行ごとの NULL 指標（列順） */
  nulls: boolean[][];
}

/**
 * 拡張結果データ（CP `0x380E`）を解析する。
 *
 * 固定部 20 バイトのあと、行ごとに「NULL 指標（列数 × 指標サイズ）＋行データ」が並ぶ。
 */
export function parseExtendedResultData(value: Uint8Array): ExtResultData {
  if (value.length < 20) {
    throw new As400Error("PROTOCOL_ERROR", `extended result data too short: ${value.length} bytes`);
  }
  const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
  const rowCount = view.getUint32(4);
  const columnCount = view.getUint16(8);
  const indicatorSize = view.getUint16(10);
  const rowSize = view.getUint32(16);

  const indicatorsAt = 20;
  const rows: Uint8Array[] = [];
  const nulls: boolean[][] = [];
  // 指標は全行ぶんが先に並び、そのあとに行データが続く
  const dataAt = indicatorsAt + rowCount * columnCount * indicatorSize;

  for (let r = 0; r < rowCount; r++) {
    const rowAt = dataAt + r * rowSize;
    if (rowAt + rowSize > value.length) {
      throw new As400Error(
        "PROTOCOL_ERROR",
        `extended result data truncated at row ${r} (${value.length} bytes)`
      );
    }
    rows.push(value.subarray(rowAt, rowAt + rowSize));

    const rowNulls: boolean[] = [];
    for (let c = 0; c < columnCount; c++) {
      if (indicatorSize === 0) {
        rowNulls.push(false);
        continue;
      }
      const at = indicatorsAt + indicatorSize * (r * columnCount + c);
      // 指標は負なら NULL（元形式と同じ規則）
      rowNulls.push(at + 2 <= value.length ? view.getInt16(at) < 0 : false);
    }
    nulls.push(rowNulls);
  }
  return { rows, nulls };
}
