/**
 * パラメータマーカーの値を、サーバーが教えた形式どおりにバイト列へ詰める。
 *
 * **型ごとのバイト数を推測しない**のが要点。何バイト占めるかは `MarkerFormat` が持っており
 * （サーバーの申告）、ここは「その枠に値をどう置くか」だけを決める。
 * DDM 経路が自前でレコード配置を計算していたのとは対照的で、
 * ずれが起きうる箇所が構造的に無い。
 *
 * 参照: jtopenlite `JDBCPreparedStatement.getExtendedParameterMarkerData` と
 * `Column.convertToBytes` に対応する。逐語移植ではなく、
 * バイト配置という事実に基づく書き起こし（IPL 1.0。AGENTS.md）。
 */
import { As400Error } from "../../errors.js";
import { codecForCcsid } from "../../codec/codec.js";
import { isPureDbcsCcsid, pureDbcsCodecForCcsid } from "../../codec/pure-dbcs.js";
import { encodePacked, encodeZoned } from "../ddm/encode.js";
import { DB2, baseType, typeName } from "./db-types.js";
import type { MarkerField, MarkerFormat } from "./marker-format.js";

/** EBCDIC の空白。固定長文字フィールドの詰め物 */
const EBCDIC_SPACE = 0x40;
/** NULL を表す指標。**値の側は触らない**（サーバーは指標を見る） */
const NULL_INDICATOR = 0xffff;
/** 指標 1 つのバイト数 */
const INDICATOR_SIZE = 2;
/** マーカーデータの固定ヘッダー長 */
const HEADER_LEN = 20;

/** 1 行ぶんの詰め終わったバイト列と、列ごとの NULL 可否 */
export interface MarkerRow {
  data: Uint8Array;
  nulls: boolean[];
}

/** 値を詰められなかったときの理由。呼び出し側が行番号を添えて返せるようにする */
export class MarkerEncodeError extends As400Error {
  constructor(
    readonly columnIndex: number,
    readonly reason: string,
    code: "UNSUPPORTED_TYPE" | "CONFIG_ERROR" = "CONFIG_ERROR"
  ) {
    super(code, reason);
    this.name = "MarkerEncodeError";
  }
}

/**
 * 1 行を形式どおりに詰める。
 *
 * 値は**すべて文字列か null**で受ける（CSV から来るため）。
 * 数値への解釈はここで行い、失敗したら詰めずに拒否する。
 */
export function encodeMarkerRow(
  format: MarkerFormat,
  values: readonly (string | null)[]
): MarkerRow {
  if (values.length !== format.fields.length) {
    throw new As400Error(
      "CONFIG_ERROR",
      `値の数が一致しません（期待 ${format.fields.length} / 実際 ${values.length}）`
    );
  }
  const data = new Uint8Array(format.rowSize);
  const nulls: boolean[] = new Array(format.fields.length).fill(false);

  for (let i = 0; i < format.fields.length; i++) {
    const field = format.fields[i]!;
    const value = values[i]!;
    if (value === null) {
      // **データ領域は初期値のままでよい**——サーバーは指標を見る
      nulls[i] = true;
      continue;
    }
    encodeField(data, field, value, i);
  }
  return { data, nulls };
}

/** 1 フィールドを枠に置く */
function encodeField(
  out: Uint8Array,
  field: MarkerField,
  value: string,
  index: number
): void {
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const t = baseType(field.sqlType);

  switch (t) {
    case DB2.SMALLINT:
    case DB2.INTEGER:
    case DB2.BIGINT:
      writeInt(view, field, value, index);
      return;

    case DB2.DECIMAL:
      // 既存の DDM 用エンコーダを再利用する（パック 10 進の作り方は経路によらず同じ）。
      // ただし**長さはサーバーの申告と突き合わせる**——このモジュールの他の分岐と違い、
      // encodePacked は precision から幅を導くので、申告とずれると隣の列を踏む
      out.set(
        fitExactly(wrapNumeric(() => encodePacked(value, field.precision, field.scale), index), field, index),
        field.offset
      );
      return;

    case DB2.NUMERIC:
      out.set(
        fitExactly(wrapNumeric(() => encodeZoned(value, field.precision, field.scale), index), field, index),
        field.offset
      );
      return;

    case DB2.CHAR:
      out.set(fixedText(value, field, index), field.offset);
      return;

    case DB2.VARCHAR: {
      // 可変長は **2 バイトの長さ ＋ 本体**。枠は「宣言長 + 2」で与えられている
      const bytes = encodeText(value, field, index);
      if (bytes.length > field.length - 2) {
        throw new MarkerEncodeError(
          index,
          `${field.length - 2} バイトの列に ${bytes.length} バイトの値です`
        );
      }
      view.setUint16(field.offset, bytes.length);
      out.set(bytes, field.offset + 2);
      return;
    }

    case DB2.GRAPHIC:
      out.set(fixedText(value, field, index), field.offset);
      return;

    case DB2.VARGRAPHIC: {
      const bytes = encodeText(value, field, index);
      if (bytes.length > field.length - 2) {
        throw new MarkerEncodeError(
          index,
          `${field.length - 2} バイトの列に ${bytes.length} バイトの値です`
        );
      }
      // 可変長 GRAPHIC の長さは**文字数**（2 バイト単位）
      view.setUint16(field.offset, bytes.length / 2);
      out.set(bytes, field.offset + 2);
      return;
    }

    case DB2.DATE:
    case DB2.TIME:
    case DB2.TIMESTAMP:
      // **文字列としてそのまま置く**。書式の解釈はホストに任せる
      out.set(fixedText(value, field, index), field.offset);
      return;

    default:
      // **黙って 0 埋めしない**。対応していない型は列と型名を添えて拒否する
      throw new MarkerEncodeError(
        index,
        `対応していない型です: ${typeName(field.sqlType)}（${field.sqlType}）`,
        "UNSUPPORTED_TYPE"
      );
  }
}

/** 整数（ビッグエンディアン）。枠のバイト数で幅が決まる */
function writeInt(view: DataView, field: MarkerField, value: string, index: number): void {
  let v: bigint;
  try {
    v = BigInt(value.trim());
  } catch {
    throw new MarkerEncodeError(index, `数値として解釈できません: ${value}`);
  }
  const bits = BigInt(field.length * 8);
  const min = -(2n ** (bits - 1n));
  const max = 2n ** (bits - 1n) - 1n;
  if (v < min || v > max) {
    throw new MarkerEncodeError(index, `${field.length * 8} ビット整数に収まりません: ${value}`);
  }
  if (field.length === 2) view.setInt16(field.offset, Number(v));
  else if (field.length === 4) view.setInt32(field.offset, Number(v));
  else view.setBigInt64(field.offset, v);
}

/** 10 進系の例外を拒否理由に変える */
function wrapNumeric(fn: () => Uint8Array, index: number): Uint8Array {
  try {
    return fn();
  } catch (e) {
    throw new MarkerEncodeError(index, e instanceof Error ? e.message : String(e));
  }
}

/**
 * 型から導いた幅が、サーバーの申告した枠とぴったり合うことを確かめる。
 *
 * 数値の 10 進系だけは既存エンコーダ（`precision` から長さを決める）を再利用しており、
 * **このモジュールで唯一「枠を自分で導いている」箇所**になる。
 * ずれたまま書くと隣の列を上書きするので、**合わなければ書かずに拒否する**。
 */
function fitExactly(bytes: Uint8Array, field: MarkerField, index: number): Uint8Array {
  if (bytes.length !== field.length) {
    throw new MarkerEncodeError(
      index,
      `枠のバイト数が合いません（サーバー申告 ${field.length} / 生成 ${bytes.length}）。` +
        `精度 ${field.precision} 位取り ${field.scale}`
    );
  }
  return bytes;
}

/** 固定長の文字フィールド。**右を空白で詰める**（超過は拒否） */
function fixedText(value: string, field: MarkerField, index: number): Uint8Array {
  const bytes = encodeText(value, field, index);
  if (bytes.length > field.length) {
    throw new MarkerEncodeError(
      index,
      `${field.length} バイトの列に ${bytes.length} バイトの値です`
    );
  }
  const out = new Uint8Array(field.length).fill(EBCDIC_SPACE);
  out.set(bytes, 0);
  return out;
}

/**
 * 列の CCSID で符号化する。
 *
 * **置換文字が出たら拒否する**——書けない文字を黙って `` に変えると、
 * 壊れた値が静かに保存される（DDM 経路の `encodeChar` と同じ方針）。
 */
function encodeText(value: string, field: MarkerField, index: number): Uint8Array {
  const ccsid = field.ccsid;
  if (ccsid === 0 || ccsid === 65535) {
    throw new MarkerEncodeError(index, `文字コードが不明な列です（CCSID ${ccsid}）`);
  }
  try {
    const codec = isPureDbcsCcsid(ccsid) ? pureDbcsCodecForCcsid(ccsid) : codecForCcsid(ccsid);
    const { bytes, substituted } = codec.encode(value);
    if (substituted > 0) {
      const chars = [...value].filter((ch) => codec.encode(ch).substituted > 0);
      throw new MarkerEncodeError(
        index,
        `CCSID ${ccsid} では書けない文字が含まれます: ${chars.join(", ")}`
      );
    }
    return bytes;
  } catch (e) {
    if (e instanceof MarkerEncodeError) throw e;
    throw new MarkerEncodeError(index, `CCSID ${ccsid} に対応していません`, "UNSUPPORTED_TYPE");
  }
}

/**
 * N 行ぶんのマーカーデータを組み立てる。
 *
 * ```
 * [0..3]   一貫性トークン = 1
 * [4..7]   行数 N          ← ここを増やすだけで複数行になる
 * [8..9]   列数
 * [10..11] 指標サイズ = 2
 * [16..19] 行サイズ
 * [20..]   指標: 2 バイト × 列数 × N（NULL は 0xFFFF）
 * [..]     行データ: 行サイズ × N
 * ```
 */
export function buildMarkerData(format: MarkerFormat, rows: readonly MarkerRow[]): Uint8Array {
  const n = rows.length;
  const columns = format.fields.length;
  const indicatorsLen = n * columns * INDICATOR_SIZE;
  const out = new Uint8Array(HEADER_LEN + indicatorsLen + n * format.rowSize);
  const view = new DataView(out.buffer);

  view.setUint32(0, 1);
  view.setUint32(4, n);
  view.setUint16(8, columns);
  view.setUint16(10, INDICATOR_SIZE);
  view.setUint32(16, format.rowSize);

  const dataAt = HEADER_LEN + indicatorsLen;
  rows.forEach((row, r) => {
    row.nulls.forEach((isNull, c) => {
      if (!isNull) return;
      view.setUint16(HEADER_LEN + (r * columns + c) * INDICATOR_SIZE, NULL_INDICATOR);
    });
    out.set(row.data, dataAt + r * format.rowSize);
  });
  return out;
}

/** N 行を詰めたときのマーカーデータの総バイト数（バッチ分割の判断に使う） */
export function markerDataSize(format: MarkerFormat, rowCount: number): number {
  return (
    HEADER_LEN + rowCount * format.fields.length * INDICATOR_SIZE + rowCount * format.rowSize
  );
}
