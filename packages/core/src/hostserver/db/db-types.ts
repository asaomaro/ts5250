/**
 * DB2 for i の型コードと、その解釈。
 *
 * **型コードは偶数が NOT NULL、+1 した奇数が NULL 可**を表す。
 * 判定は最下位ビットで行う（原典も `case DB2Type.CHAR+1:` の形で書かれている）。
 *
 * 参照: JTOpen(jtopenlite) の DB2Type / Column に対応する。
 */

/** NULL 可を除いた基底の型コード */
export const DB2 = {
  DATE: 384,
  TIME: 388,
  TIMESTAMP: 392,
  DATALINK: 396,
  BLOB: 404,
  CLOB: 408,
  DBCLOB: 412,
  VARCHAR: 448,
  CHAR: 452,
  LONGVARCHAR: 456,
  VARGRAPHIC: 464,
  GRAPHIC: 468,
  LONGVARGRAPHIC: 472,
  FLOAT: 480,
  /** パック 10 進数 */
  DECIMAL: 484,
  /** ゾーン 10 進数 */
  NUMERIC: 488,
  BIGINT: 492,
  INTEGER: 496,
  SMALLINT: 500,
  ROWID: 904,
  VARBINARY: 908,
  BINARY: 912,
  BLOB_LOCATOR: 960,
  CLOB_LOCATOR: 964,
  DBCLOB_LOCATOR: 968,
  XML: 988,
  DECFLOAT: 996,
  XML_LOCATOR: 2452
} as const;

const NAMES = new Map<number, string>(
  Object.entries(DB2).map(([name, code]) => [code, name])
);

/** 生の型コードから NULL 可を判定する（奇数＝NULL 可） */
export function isNullableType(rawType: number): boolean {
  return (rawType & 1) === 1;
}

/** 生の型コードから基底の型コードを得る（奇数なら 1 を引く） */
export function baseType(rawType: number): number {
  return rawType & ~1;
}

/** 型名。未知のコードは "UNKNOWN(<code>)" */
export function typeName(rawType: number): string {
  return NAMES.get(baseType(rawType)) ?? `UNKNOWN(${baseType(rawType)})`;
}

/** この作業で値を返せる型か（LOB・XML 等は対象外） */
export function isSupportedType(rawType: number): boolean {
  return SUPPORTED.has(baseType(rawType));
}

const SUPPORTED: ReadonlySet<number> = new Set([
  DB2.DATE,
  DB2.TIME,
  DB2.TIMESTAMP,
  DB2.VARCHAR,
  DB2.CHAR,
  DB2.LONGVARCHAR,
  DB2.VARGRAPHIC,
  DB2.GRAPHIC,
  DB2.LONGVARGRAPHIC,
  DB2.FLOAT,
  DB2.DECIMAL,
  DB2.NUMERIC,
  DB2.BIGINT,
  DB2.INTEGER,
  DB2.SMALLINT
]);

/** 値として返す JavaScript の型。利用側が事前に判断できるよう列メタデータに載せる */
export type JsType = "string" | "number" | "bigint";

/**
 * 型コードに対応する JavaScript の型。
 *
 * **10 進数は `string`**——`number` は 2^53 を超えると精度を失い、
 * 金額のような列で静かに誤った値を返すため（spec D2）。
 * **BIGINT は `bigint`**——整数なので正確に持てる。
 * **日付時刻は `string`**——IBM i の値はタイムゾーンを持たず、`Date` にすると解釈がずれる。
 */
export function jsTypeOf(rawType: number): JsType {
  switch (baseType(rawType)) {
    case DB2.DECIMAL:
    case DB2.NUMERIC:
      return "string";
    case DB2.BIGINT:
      return "bigint";
    case DB2.INTEGER:
    case DB2.SMALLINT:
    case DB2.FLOAT:
      return "number";
    default:
      return "string";
  }
}
