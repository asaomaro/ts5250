import { describe, it, expect } from "vitest";
import { decodeValue, decodeRow, toColumnMeta, type ColumnMeta } from "../src/hostserver/db/db-decode.js";
import { DB2 } from "../src/hostserver/db/db-types.js";
import { Tn5250Error } from "../src/errors.js";

/**
 * 実機テスト表 MYLIB.SQLTYPES の型を、固定バイト列で再現して検証する。
 * 実機との突き合わせは T11 で行い、ここは変換ロジックの回帰検出に徹する。
 */
const meta = (over: Partial<ColumnMeta> & { type: number; offset: number; length: number }): ColumnMeta =>
  toColumnMeta({
    name: over.name ?? "C",
    type: over.type,
    offset: over.offset,
    length: over.length,
    scale: over.scale ?? 0,
    precision: over.precision ?? 0,
    ccsid: over.ccsid ?? 273
  });

const buf = (...v: number[]): Uint8Array => Uint8Array.from(v);

describe("NULL の扱い", () => {
  it("NULL 指標が立っていれば null（バイト列の中身に関わらず）", () => {
    const m = meta({ type: DB2.INTEGER, offset: 0, length: 4 });
    expect(decodeValue(buf(0, 0, 0, 42), m, true)).toBeNull();
  });

  it("NULL と空文字は区別できる", () => {
    const m = meta({ type: DB2.CHAR, offset: 0, length: 2, ccsid: 273 });
    expect(decodeValue(buf(0x40, 0x40), m, false)).toBe("  "); // EBCDIC 空白
    expect(decodeValue(buf(0x40, 0x40), m, true)).toBeNull();
  });
});

describe("整数", () => {
  it("SMALLINT は符号付き 2 バイト", () => {
    const m = meta({ type: DB2.SMALLINT, offset: 0, length: 2 });
    expect(decodeValue(buf(0x00, 0x01), m, false)).toBe(1);
    expect(decodeValue(buf(0xff, 0xff), m, false)).toBe(-1);
  });

  it("INTEGER は符号付き 4 バイト（実機の 2147483647）", () => {
    const m = meta({ type: DB2.INTEGER, offset: 0, length: 4 });
    expect(decodeValue(buf(0x7f, 0xff, 0xff, 0xff), m, false)).toBe(2147483647);
  });

  it("BIGINT は bigint で返す（2^53 を超えても精度を落とさない）", () => {
    const m = meta({ type: DB2.BIGINT, offset: 0, length: 8 });
    // 9007199254740993 = 2^53 + 1。number では 9007199254740992 になってしまう
    const v = decodeValue(buf(0x00, 0x20, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01), m, false);
    expect(v).toBe(9007199254740993n);
    expect(v!.toString()).toBe("9007199254740993");
    // number に落とすと 1 の位が失われる。これが string/bigint を選んだ理由
    expect(Number(v).toString()).toBe("9007199254740992");
  });
});

describe("浮動小数", () => {
  it("長さ 8 は倍精度", () => {
    const m = meta({ type: DB2.FLOAT, offset: 0, length: 8 });
    expect(decodeValue(buf(0x3f, 0xf8, 0, 0, 0, 0, 0, 0), m, false)).toBe(1.5);
  });

  it("長さ 4 は単精度", () => {
    const m = meta({ type: DB2.FLOAT, offset: 0, length: 4 });
    expect(decodeValue(buf(0x3f, 0xc0, 0x00, 0x00), m, false)).toBe(1.5);
  });
});

describe("10 進数（文字列で返す）", () => {
  it("DECIMAL は実機の -12345678.91", () => {
    const m = meta({ type: DB2.DECIMAL, offset: 0, length: 6, precision: 11, scale: 2 });
    expect(decodeValue(buf(0x01, 0x23, 0x45, 0x67, 0x89, 0x1d), m, false)).toBe("-12345678.91");
  });

  it("NUMERIC は実機の 1.234", () => {
    const m = meta({ type: DB2.NUMERIC, offset: 0, length: 7, precision: 7, scale: 3 });
    expect(decodeValue(buf(0xf0, 0xf0, 0xf0, 0xf1, 0xf2, 0xf3, 0xc4), m, false)).toBe("1.234");
  });

  it("number ではなく string で返る", () => {
    const m = meta({ type: DB2.DECIMAL, offset: 0, length: 2, precision: 3, scale: 0 });
    expect(typeof decodeValue(buf(0x12, 0x3c), m, false)).toBe("string");
  });
});

describe("文字列", () => {
  it("CHAR は末尾の空白を落とさない（固定長。切るかは利用側の判断）", () => {
    const m = meta({ type: DB2.CHAR, offset: 0, length: 10, ccsid: 273 });
    // "ABC" + EBCDIC 空白 7 個
    const b = buf(0xc1, 0xc2, 0xc3, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40);
    expect(decodeValue(b, m, false)).toBe("ABC       ");
  });

  it("VARCHAR は先頭 2 バイトがバイト長", () => {
    const m = meta({ type: DB2.VARCHAR, offset: 0, length: 22, ccsid: 273 });
    // 長さ 5 + "hello"
    const b = new Uint8Array(22);
    b[1] = 5;
    b.set([0x88, 0x85, 0x93, 0x93, 0x96], 2);
    expect(decodeValue(b, m, false)).toBe("hello");
  });

  it("VARCHAR の長さがバッファを超えていたら拒否する（隣の列を読まない）", () => {
    const m = meta({ type: DB2.VARCHAR, offset: 0, length: 10, ccsid: 273 });
    const b = new Uint8Array(10);
    b[0] = 0xff;
    b[1] = 0xff;
    expect(() => decodeValue(b, m, false)).toThrow(/declares length/);
  });
});

describe("GRAPHIC（純 DBCS）", () => {
  it("CCSID 16684 の 日本", () => {
    const m = meta({ type: DB2.GRAPHIC, offset: 0, length: 4, ccsid: 16684 });
    expect(decodeValue(buf(0x45, 0x62, 0x45, 0x66), m, false)).toBe("日本");
  });

  it("CCSID 300 の アイ", () => {
    const m = meta({ type: DB2.GRAPHIC, offset: 0, length: 4, ccsid: 300 });
    expect(decodeValue(buf(0x43, 0x81, 0x43, 0x82), m, false)).toBe("アイ");
  });

  it("同じバイト列でも CCSID 300 と 16684 で結果が変わる（波ダッシュ）", () => {
    const b = buf(0x43, 0xa1);
    const m300 = meta({ type: DB2.GRAPHIC, offset: 0, length: 2, ccsid: 300 });
    const m16684 = meta({ type: DB2.GRAPHIC, offset: 0, length: 2, ccsid: 16684 });
    expect(decodeValue(b, m300, false)).toBe("～");
    expect(decodeValue(b, m16684, false)).toBe("〜");
  });

  it("VARGRAPHIC は先頭 2 バイトが【文字数】（バイト長ではない）", () => {
    const m = meta({ type: DB2.VARGRAPHIC, offset: 0, length: 22, ccsid: 16684 });
    const b = new Uint8Array(22);
    b[1] = 2; // 2 文字 = 4 バイト
    b.set([0x45, 0x62, 0x45, 0x66], 2);
    expect(decodeValue(b, m, false)).toBe("日本");
  });

  it("UTF-16 の CCSID も読める", () => {
    const m = meta({ type: DB2.GRAPHIC, offset: 0, length: 4, ccsid: 1200 });
    expect(decodeValue(buf(0x65, 0xe5, 0x67, 0x2c), m, false)).toBe("日本");
  });

  it("未対応の CCSID は明示的に失敗する", () => {
    const m = meta({ type: DB2.GRAPHIC, offset: 0, length: 2, ccsid: 4396 });
    expect(() => decodeValue(buf(0x45, 0x62), m, false)).toThrow(/unsupported CCSID/);
  });
});

describe("日付・時刻（書式化済みの文字列）", () => {
  const ebcdic = (s: string): number[] => {
    const map: Record<string, number> = {
      "0": 0xf0, "1": 0xf1, "2": 0xf2, "3": 0xf3, "4": 0xf4,
      "5": 0xf5, "6": 0xf6, "7": 0xf7, "8": 0xf8, "9": 0xf9,
      "-": 0x60, ".": 0x4b
    };
    return [...s].map((c) => map[c]!);
  };

  it("DATE は ISO 形式のまま返す（Date にしない）", () => {
    const m = meta({ type: DB2.DATE, offset: 0, length: 10, ccsid: 273 });
    expect(decodeValue(Uint8Array.from(ebcdic("2026-07-18")), m, false)).toBe("2026-07-18");
  });

  it("TIME も文字列", () => {
    const m = meta({ type: DB2.TIME, offset: 0, length: 8, ccsid: 273 });
    expect(decodeValue(Uint8Array.from(ebcdic("12.34.56")), m, false)).toBe("12.34.56");
  });
});

describe("範囲外・未対応", () => {
  it("列がバッファをはみ出したら PROTOCOL_ERROR", () => {
    const m = meta({ type: DB2.INTEGER, offset: 8, length: 4 });
    expect(() => decodeValue(new Uint8Array(4), m, false)).toThrow(Tn5250Error);
    expect(() => decodeValue(new Uint8Array(4), m, false)).toThrow(/out of range/);
  });

  it("対象外の型は HOST_SERVER_UNSUPPORTED", () => {
    const m = meta({ type: DB2.BLOB, offset: 0, length: 4 });
    try {
      decodeValue(new Uint8Array(4), m, false);
      expect.unreachable();
    } catch (e) {
      expect((e as Tn5250Error).code).toBe("HOST_SERVER_UNSUPPORTED");
    }
  });
});

describe("decodeRow", () => {
  it("列名をキーにしたオブジェクトを作る", () => {
    const cols = [
      meta({ name: "ID", type: DB2.SMALLINT, offset: 0, length: 2 }),
      meta({ name: "N", type: DB2.INTEGER, offset: 2, length: 4 })
    ];
    const row = buf(0x00, 0x07, 0x00, 0x00, 0x00, 0x2a);
    expect(decodeRow(row, cols, [false, false])).toEqual({ ID: 7, N: 42 });
  });

  it("NULL 指標を列ごとに反映する", () => {
    const cols = [
      meta({ name: "ID", type: DB2.SMALLINT, offset: 0, length: 2 }),
      meta({ name: "N", type: DB2.INTEGER, offset: 2, length: 4 })
    ];
    const row = buf(0x00, 0x02, 0xff, 0xff, 0xff, 0xff);
    expect(decodeRow(row, cols, [false, true])).toEqual({ ID: 2, N: null });
  });
});

describe("toColumnMeta", () => {
  it("NULL 可（型コード +1）を解いて基底型に戻す", () => {
    const m = toColumnMeta({
      name: "C", type: DB2.CHAR + 1, offset: 0, length: 10, scale: 0, precision: 0, ccsid: 273
    });
    expect(m.type).toBe(DB2.CHAR);
    expect(m.nullable).toBe(true);
    expect(m.typeName).toBe("CHAR");
  });

  it("jsType を載せて利用側が型を事前に判断できるようにする", () => {
    const dec = toColumnMeta({
      name: "D", type: DB2.DECIMAL, offset: 0, length: 6, scale: 2, precision: 11, ccsid: 273
    });
    expect(dec.jsType).toBe("string");
  });
});
