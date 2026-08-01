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
import { As400Error } from "@as400web/base";
import { codecForCcsid, pureDbcsCodecForCcsid, isPureDbcsCcsid } from "@as400web/ebcdic";
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
  /** ロケーターのハンドル。**接続に紐づく**（別接続では無効） */
  locator: number;
  /** 列定義が申告する最大サイズ */
  maxSize: number;
  /** 取得できた中身。未取得なら undefined */
  value?: string | Uint8Array;
  /** LOB 全体のバイト長（取得できたときのみ分かる） */
  byteLength?: number;
  /**
   * 未取得の理由。取得できたときは undefined。
   * **空文字で埋めない**——空の LOB と「取っていない」が区別できなくなる。
   *
   * - `not-requested`: 取りに行っていない（既定。`lobMaxBytes` を指定しなかった）
   * - `too-large`: 取れたが上限で打ち切った（`value` に先頭だけ入る）
   * - `failed`: **取りに行って失敗した**
   *
   * **`failed` を `not-requested` に混ぜない**——読み手は「要求していない」を見て
   * 「では要求すればよい」と案内するため（`SqlResultTable.vue` の `lobTitle`）。
   * 既に要求した人に同じ操作を勧めることになる。
   *
   * 排他なので**フラグを増やさず 1 つの union で表す**。別フィールドに割ると
   * 「要求していないのに失敗した」のような表現不能な状態を型が許してしまう（spec D1）。
   */
  unavailable?: "not-requested" | "too-large" | "failed";
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
    // 既定では本体を取りに行かない。**そうと分かる状態で返す**
    return { kind: "lob", locator, maxSize: meta.lobMaxSize ?? 0, unavailable: "not-requested" };
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

    // **ロケーターではない LOB**（しきい値以下で行データに載ってきたもの）。
    // 長さの接頭辞は **4 バイト**——VARCHAR の 2 バイトとは違う
    // （実機で `00 00 00 64` ＋ 100 バイトの本体を確認）。
    // 追加の往復が要らない代わりに、行の応答がその分ふくらむ。
    //
    // **`LobPlaceholder` の形で返す**。値の届き方（ロケーター経由 / インライン）で
    // 利用側の分岐を増やさないため——同じ列は設定次第でどちらでも来る。
    // `locator` は 0（＝インラインなのでロケーターは無い。取り直す先も無い）。
    case DB2.CLOB:
    case DB2.BLOB: {
      const len = view.getUint32(at);
      assertVarLength(meta, len, meta.length - 4);
      const body = row.subarray(at + 4, at + 4 + len);
      return inlineLob(meta, len, meta.type === DB2.BLOB ? new Uint8Array(body) : decodeText(body, meta.ccsid));
    }
    case DB2.DBCLOB: {
      // **接頭辞は【文字数】**（CLOB / BLOB のバイト数とは違う）。VARGRAPHIC と同じ。
      // バイト数として読むと `日本語`（3 文字）が `日` になる——実機で踏んだ
      const chars = view.getUint32(at);
      assertVarLength(meta, chars * 2, meta.length - 4);
      return inlineLob(meta, chars * 2, decodeGraphic(row.subarray(at + 4, at + 4 + chars * 2), meta.ccsid));
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

/**
 * 行データに載って届いた LOB を `LobPlaceholder` に包む。
 *
 * **ロケーター経由と同じ形で返す**——値の届き方（ロケーター / インライン）は
 * 接続時のしきい値で決まるので、利用側に分岐を持たせない。
 * `locator: 0` は「インラインなのでロケーターは無い（取り直す先も無い）」の意。
 */
function inlineLob(meta: ColumnMeta, byteLength: number, value: string | Uint8Array): LobPlaceholder {
  return { kind: "lob", locator: 0, maxSize: meta.lobMaxSize ?? 0, byteLength, value };
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

/**
 * この CCSID は **1 文字 2 バイト**か（UTF-16 / 純 DBCS）。
 *
 * ホストが申告する長さの**単位がこれで変わる**——2 バイト系では**文字数**、
 * それ以外は**バイト数**で来る。実機で両方を確かめた
 * （`DBCLOB CCSID 1200` は文字数 / `CLOB`（混在 5035）は SO・SI 込みのバイト数。
 * `20260801-dbclob-locator-decode`）。
 *
 * **SBCS だけで試すと一致してしまい判別できない。** 必ず全角を含む値で確かめること。
 */
export function isTwoByteCcsid(ccsid: number): boolean {
  return UTF16_CCSIDS.has(ccsid) || isPureDbcsCcsid(ccsid);
}

/**
 * ロケーター経由で受け取った LOB のバイト列を文字にする。
 *
 * **判定をここに集約する。** 以前は `query.ts` が `codecForCcsid` だけを試しており、
 * UTF-16（1200 / 13488）で失敗してバイト列のまま返していた——
 * 同じ CCSID を `decodeText` / `decodeGraphic` は扱えていたのに、
 * **同じ判定が 2 か所にあって片方だけ正しかった**。
 *
 * @param ccsid 0 なら BLOB。バイト列のまま返す
 */
export function decodeLobBytes(bytes: Uint8Array, ccsid: number): string | Uint8Array {
  if (ccsid === 0) return bytes;
  try {
    if (UTF16_CCSIDS.has(ccsid)) return decodeUtf16Be(bytes);
    if (isPureDbcsCcsid(ccsid)) return pureDbcsCodecForCcsid(ccsid).decode(bytes);
    return codecForCcsid(ccsid).decode(bytes);
  } catch {
    // 未知の CCSID は**壊れた文字列にせず**バイト列で返す（既存の方針）
    return bytes;
  }
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
