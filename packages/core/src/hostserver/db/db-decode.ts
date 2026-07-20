/**
 * 行バッファ → JavaScript 値。
 *
 * 行は**固定長レコード**で、各列は固定オフセットを持つ。可変長列は先頭 2 バイトが長さ。
 * NULL 指標は行データとは別に届くため、ここでは「NULL かどうか」を引数で受け取る。
 *
 * 参照: JTOpen(jtopenlite) の Column.getString / getObject に対応する。
 *       ただし純 DBCS の GRAPHIC は jtopenlite が実装しておらず（UTF-16 以外は例外）、
 *       本実装は JTOpen 本体の ConvTable16684 / ConvTable300 相当の変換を行う。
 */
import { As400Error } from "../../errors.js";
import { codecForCcsid } from "../../codec/codec.js";
import { pureDbcsCodecForCcsid, isPureDbcsCcsid } from "../../codec/pure-dbcs.js";
import { DB2, baseType, typeName, jsTypeOf, isSupportedType } from "./db-types.js";
import { packedDecimalToString, zonedDecimalToString } from "./db-decimal.js";

/** UTF-16 を表す CCSID。EBCDIC ではないので直接読む */
const UTF16_CCSIDS: ReadonlySet<number> = new Set([1200, 13488]);

/**
 * LOB 列の値。**ロケーター（ハンドル）しか受け取っていない**ことを表す。
 *
 * `null` にしない——SQL の NULL と「取得していない」が区別できなくなるため。
 * 本体を取るにはロケーター経由の別要求が要る（未実装）。
 */
export interface LobPlaceholder {
  kind: "lob";
  /** ロケーターのハンドル。将来 retrieveLOBData で本体を取るのに使う */
  locator: number;
  /** 列定義が申告する最大サイズ */
  maxSize: number;
}

export type DbValue = string | number | bigint | null | LobPlaceholder;

/** 列のメタデータ */
export interface ColumnMeta {
  name: string;
  /** 基底の型コード（NULL 可の +1 は除いてある） */
  type: number;
  typeName: string;
  /** 行バッファ内のオフセット */
  offset: number;
  /** バイト長 */
  length: number;
  scale: number;
  precision: number;
  ccsid: number;
  nullable: boolean;
  jsType: ReturnType<typeof jsTypeOf>;
  /** **0 以外なら LOB**（ロケーターしか得ていない）。超拡張形式でのみ設定される */
  lobLocator?: number;
  lobMaxSize?: number;
}

/** 生の列定義から ColumnMeta を組み立てる */
export function toColumnMeta(raw: {
  name: string;
  type: number;
  offset: number;
  length: number;
  scale: number;
  precision: number;
  ccsid: number;
}): ColumnMeta {
  return {
    name: raw.name,
    type: baseType(raw.type),
    typeName: typeName(raw.type),
    offset: raw.offset,
    length: raw.length,
    scale: raw.scale,
    precision: raw.precision,
    ccsid: raw.ccsid,
    nullable: (raw.type & 1) === 1,
    jsType: jsTypeOf(raw.type)
  };
}

/**
 * 1 列分の値を取り出す。
 *
 * @param isNull NULL 指標（行データとは別に届く。research F8）
 */
/** ロケーターとして返される LOB の型か（しきい値 0 のとき LOB は必ずこれになる） */
function isLobLocatorType(type: number): boolean {
  return type === DB2.BLOB_LOCATOR || type === DB2.CLOB_LOCATOR || type === DB2.DBCLOB_LOCATOR;
}

export function decodeValue(row: Uint8Array, meta: ColumnMeta, isNull: boolean): DbValue {
  if (isNull) return null;
  // **LOB はロケーターしか来ていない**。値として復号せず、そうと分かる形で返す
  // （`null` にすると SQL の NULL と区別できなくなる）。
  // 判定は**型コード**で行う——ロケーターのハンドルは列定義ではなく
  // **行データの中に 4 バイト**で入っており、列定義側の LOB フィールドは 0 のことがある。
  if (isLobLocatorType(meta.type)) {
    const view = new DataView(row.buffer, row.byteOffset, row.byteLength);
    const locator = meta.offset + 4 <= row.length ? view.getUint32(meta.offset) : 0;
    return { kind: "lob", locator, maxSize: meta.lobMaxSize ?? 0 };
  }
  if (!isSupportedType(meta.type)) {
    throw new As400Error(
      "HOST_SERVER_UNSUPPORTED",
      `column "${meta.name}" has unsupported type ${meta.typeName} (${meta.type})`
    );
  }
  assertRange(row, meta);
  const view = new DataView(row.buffer, row.byteOffset, row.byteLength);
  const at = meta.offset;

  switch (meta.type) {
    case DB2.SMALLINT:
      return view.getInt16(at);
    case DB2.INTEGER:
      return view.getInt32(at);
    case DB2.BIGINT:
      // number にすると 2^53 を超える値で精度が落ちるため bigint で返す
      return view.getBigInt64(at);
    case DB2.FLOAT:
      return meta.length === 4 ? view.getFloat32(at) : view.getFloat64(at);

    case DB2.DECIMAL:
      return packedDecimalToString(row, at, meta.precision, meta.scale);
    case DB2.NUMERIC:
      return zonedDecimalToString(row, at, meta.precision, meta.scale);

    case DB2.CHAR:
      // CHAR は固定長。**末尾の空白は落とさない**（切るかは利用側の判断）
      return decodeText(row.subarray(at, at + meta.length), meta.ccsid);
    case DB2.VARCHAR:
    case DB2.LONGVARCHAR: {
      const len = view.getUint16(at);
      assertVarLength(meta, len, meta.length - 2);
      return decodeText(row.subarray(at + 2, at + 2 + len), meta.ccsid);
    }

    case DB2.GRAPHIC:
      return decodeGraphic(row.subarray(at, at + meta.length), meta.ccsid);
    case DB2.VARGRAPHIC:
    case DB2.LONGVARGRAPHIC: {
      // 先頭 2 バイトは【文字数】。バイト長は 2 倍
      const chars = view.getUint16(at);
      assertVarLength(meta, chars * 2, meta.length - 2);
      return decodeGraphic(row.subarray(at + 2, at + 2 + chars * 2), meta.ccsid);
    }

    case DB2.DATE:
    case DB2.TIME:
    case DB2.TIMESTAMP:
      // 書式化済みの固定長文字列として入っている（research F7）。
      // Date にすると IBM i のタイムゾーンを持たない値の解釈がずれるので文字列のまま返す
      return decodeText(row.subarray(at, at + meta.length), meta.ccsid).trimEnd();

    default:
      throw new As400Error(
        "HOST_SERVER_UNSUPPORTED",
        `no decoder for type ${meta.typeName} (${meta.type})`
      );
  }
}

/** SBCS / 混在 CCSID のテキスト。UTF-16 の CCSID は直接読む */
function decodeText(bytes: Uint8Array, ccsid: number): string {
  if (UTF16_CCSIDS.has(ccsid)) return decodeUtf16Be(bytes);
  return codecForCcsid(ccsid).decode(bytes);
}

/** GRAPHIC / VARGRAPHIC。純 DBCS か UTF-16 のいずれか */
function decodeGraphic(bytes: Uint8Array, ccsid: number): string {
  if (UTF16_CCSIDS.has(ccsid)) return decodeUtf16Be(bytes);
  if (isPureDbcsCcsid(ccsid)) return pureDbcsCodecForCcsid(ccsid).decode(bytes);
  throw new As400Error(
    "HOST_SERVER_UNSUPPORTED",
    `GRAPHIC column uses unsupported CCSID ${ccsid}`
  );
}

/** UTF-16BE。TextDecoder に頼らず自前で読む（ピュア層を環境非依存に保つ） */
function decodeUtf16Be(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    out += String.fromCharCode((bytes[i]! << 8) | bytes[i + 1]!);
  }
  return out;
}

function assertRange(row: Uint8Array, meta: ColumnMeta): void {
  if (meta.offset < 0 || meta.offset + meta.length > row.length) {
    throw new As400Error(
      "PROTOCOL_ERROR",
      `column "${meta.name}" out of range (offset ${meta.offset}, length ${meta.length}, row ${row.length})`
    );
  }
}

/** 可変長の宣言長がバッファに収まるか。壊れた長さで隣の列を読まない */
function assertVarLength(meta: ColumnMeta, actual: number, max: number): void {
  if (actual < 0 || actual > max) {
    throw new As400Error(
      "PROTOCOL_ERROR",
      `column "${meta.name}" declares length ${actual} but only ${max} bytes are available`
    );
  }
}

/** 行バッファと NULL 指標から 1 行分のオブジェクトを作る */
export function decodeRow(
  row: Uint8Array,
  columns: readonly ColumnMeta[],
  nulls: readonly boolean[]
): Record<string, DbValue> {
  const out: Record<string, DbValue> = {};
  columns.forEach((meta, i) => {
    out[meta.name] = decodeValue(row, meta, nulls[i] ?? false);
  });
  return out;
}
