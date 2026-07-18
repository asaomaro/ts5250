import { describe, it, expect } from "vitest";
import {
  DB2,
  isNullableType,
  baseType,
  typeName,
  isSupportedType,
  jsTypeOf
} from "../src/hostserver/db/db-types.js";

/** 型コードは偶数が NOT NULL、+1 した奇数が NULL 可。判定は最下位ビット */
describe("NULL 可の判定", () => {
  it("偶数は NOT NULL、奇数は NULL 可", () => {
    expect(isNullableType(DB2.CHAR)).toBe(false);
    expect(isNullableType(DB2.CHAR + 1)).toBe(true);
    expect(isNullableType(DB2.DECIMAL)).toBe(false);
    expect(isNullableType(DB2.DECIMAL + 1)).toBe(true);
  });

  it("基底の型コードに戻せる", () => {
    expect(baseType(DB2.CHAR + 1)).toBe(DB2.CHAR);
    expect(baseType(DB2.CHAR)).toBe(DB2.CHAR);
    expect(baseType(DB2.GRAPHIC + 1)).toBe(DB2.GRAPHIC);
  });
});

describe("typeName", () => {
  it("NULL 可でも同じ型名になる", () => {
    expect(typeName(DB2.VARCHAR)).toBe("VARCHAR");
    expect(typeName(DB2.VARCHAR + 1)).toBe("VARCHAR");
  });

  it("未知のコードも情報を落とさない", () => {
    expect(typeName(9998)).toBe("UNKNOWN(9998)");
  });
});

describe("jsTypeOf（利用側が値の型を事前に判断できるようにする）", () => {
  it("10 進数は string（number は 2^53 超と金額で精度を失うため）", () => {
    expect(jsTypeOf(DB2.DECIMAL)).toBe("string");
    expect(jsTypeOf(DB2.NUMERIC)).toBe("string");
    expect(jsTypeOf(DB2.DECIMAL + 1)).toBe("string");
  });

  it("BIGINT は bigint（整数なので正確に持てる）", () => {
    expect(jsTypeOf(DB2.BIGINT)).toBe("bigint");
  });

  it("INTEGER / SMALLINT / FLOAT は number", () => {
    expect(jsTypeOf(DB2.INTEGER)).toBe("number");
    expect(jsTypeOf(DB2.SMALLINT)).toBe("number");
    expect(jsTypeOf(DB2.FLOAT)).toBe("number");
  });

  it("日付時刻は string（IBM i の値はタイムゾーンを持たず Date にすると解釈がずれる）", () => {
    expect(jsTypeOf(DB2.DATE)).toBe("string");
    expect(jsTypeOf(DB2.TIME)).toBe("string");
    expect(jsTypeOf(DB2.TIMESTAMP)).toBe("string");
  });

  it("文字列型は string", () => {
    for (const t of [DB2.CHAR, DB2.VARCHAR, DB2.GRAPHIC, DB2.VARGRAPHIC]) {
      expect(jsTypeOf(t)).toBe("string");
    }
  });
});

describe("isSupportedType（この作業の対象範囲）", () => {
  it("対象の型", () => {
    for (const t of [
      DB2.CHAR,
      DB2.VARCHAR,
      DB2.GRAPHIC,
      DB2.VARGRAPHIC,
      DB2.DECIMAL,
      DB2.NUMERIC,
      DB2.SMALLINT,
      DB2.INTEGER,
      DB2.BIGINT,
      DB2.FLOAT,
      DB2.DATE,
      DB2.TIME,
      DB2.TIMESTAMP
    ]) {
      expect(isSupportedType(t)).toBe(true);
      expect(isSupportedType(t + 1)).toBe(true); // NULL 可でも対象
    }
  });

  it("LOB・XML・ロケータは対象外", () => {
    for (const t of [DB2.BLOB, DB2.CLOB, DB2.DBCLOB, DB2.XML, DB2.BLOB_LOCATOR, DB2.DECFLOAT]) {
      expect(isSupportedType(t)).toBe(false);
    }
  });
});
