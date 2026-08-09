import { describe, it, expect } from "vitest";
import { parseDataFormat, parseResultData, parseSqlca } from "../src/db/db-reply.js";
import { DB2 } from "../src/db/db-types.js";
import { As400Error } from "@ts5250/base";

/**
 * 実機（IBM i 7.5 / PUB400）が実際に返したバイト列を写して固定する。
 *
 * 実機は拡張形式（0x3812 / 0x380E）ではなく**元形式**（0x3805 / 0x3806）で返す。
 * 拡張列記述子を要求しても変わらなかったため、元形式を正として実装している。
 */

/** SELECT ID, C_CHAR FROM MYLIB.SQLTYPES の列定義（CP 0x3805・116 バイト） */
const REAL_FORMAT = Buffer.from(
  // 8 バイトのヘッダー ＋ 54 バイト × 2 列
  "000000000002000c003601f40002000000040000f00001000000000000020111c9c400000000000000000000000000000000000000000000000000000000003601c5000a000a00000111f00001000000000000060111c36dc3c8c1d9000000000000000000000000000000000000000000000000",
  "hex"
);

describe("parseDataFormat（実機の応答・元形式）", () => {
  const f = parseDataFormat(new Uint8Array(REAL_FORMAT));

  it("列数とレコード長を読む", () => {
    expect(f.columns).toHaveLength(2);
    expect(f.recordSize).toBe(12);
  });

  it("列名を EBCDIC から復号する", () => {
    expect(f.columns.map((c) => c.name)).toEqual(["ID", "C_CHAR"]);
  });

  /**
   * **空白だけの名前は「無い」扱い**にする。名前を返さない表がある
   * （`QSYS2.SYSROUTINES` は実機で全列が空）。空のまま通すと全列が同じ名前になり、
   * 行を連想配列に詰めた時点で**最後の 1 列以外が消える**（2 列が 1 列になって画面に出た）。
   */
  it("名前が空白だけなら位置で名前を付ける", () => {
    const blank = new Uint8Array(REAL_FORMAT);
    // 1 列目の名前（8 + 24 の位置に 2 バイト）を EBCDIC の空白で潰す
    blank[8 + 24] = 0x40;
    blank[8 + 24 + 1] = 0x40;
    expect(parseDataFormat(blank).columns.map((c) => c.name)).toEqual(["COL1", "C_CHAR"]);
  });

  it("型と NULL 可を読む（0x01C5 = CHAR+1 = NULL 可）", () => {
    expect(f.columns[0]!.type).toBe(DB2.SMALLINT);
    expect(f.columns[0]!.nullable).toBe(false);
    expect(f.columns[1]!.type).toBe(DB2.CHAR);
    expect(f.columns[1]!.nullable).toBe(true);
  });

  it("CCSID は列ごとに持つ（数値列は 0、文字列は 273）", () => {
    expect(f.columns[0]!.ccsid).toBe(0);
    expect(f.columns[1]!.ccsid).toBe(273);
  });

  it("行内オフセットは応答に無いので長さの累積で求める", () => {
    expect(f.columns[0]!.offset).toBe(0);
    expect(f.columns[1]!.offset).toBe(2); // SMALLINT の 2 バイト分
    expect(f.columns[1]!.offset + f.columns[1]!.length).toBe(f.recordSize);
  });

  it("1 列あたり 54 バイト（8 + 54×列数 = 全長）", () => {
    expect(REAL_FORMAT.length).toBe(8 + 54 * 2);
  });

  it("短すぎる応答を拒否する", () => {
    expect(() => parseDataFormat(new Uint8Array(4))).toThrow(As400Error);
  });

  it("宣言した列数に足りない応答を拒否する", () => {
    const bad = new Uint8Array(20);
    new DataView(bad.buffer).setUint16(4, 5); // 5 列と宣言
    expect(() => parseDataFormat(bad)).toThrow(/declares 5 fields/);
  });
});

/** 上記 SELECT の結果データ（CP 0x3806・46 バイト）。行2 の C_CHAR だけ NULL */
const REAL_RESULT = Buffer.from(
  // 14 バイトのヘッダー ＋ 指標 2x2x2 ＋ 行 12x2
  "000000010000000200020002000c000000000000ffff0001c1c2c340404040404040000240404040404040404040",
  "hex"
);

describe("parseResultData（実機の応答・元形式）", () => {
  const r = parseResultData(new Uint8Array(REAL_RESULT));

  it("行数・列数・指標サイズを読む", () => {
    expect(r.rowCount).toBe(2);
    expect(r.columnCount).toBe(2);
  });

  it("NULL 指標がすべて先に並び、その後に行データが続く", () => {
    expect(r.nulls).toEqual([
      [false, false],
      [false, true]
    ]);
  });

  it("行バッファを行サイズで切り出す", () => {
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]).toHaveLength(12);
  });

  it("NULL の列も行バッファ上は場所を占める（指標だけで判断する）", () => {
    // 行2 の C_CHAR は NULL だが、バッファには空白が入っている
    expect(r.rows[1]!.subarray(2)).toEqual(new Uint8Array(10).fill(0x40));
  });

  it("ヘッダーは 14 バイト（拡張形式の 20 ではない）", () => {
    expect(REAL_RESULT.length).toBe(14 + 2 * 2 * 2 + 12 * 2);
  });

  it("短すぎる応答を拒否する", () => {
    expect(() => parseResultData(new Uint8Array(8))).toThrow(/too short/);
  });

  it("指標サイズ 0 なら全て非 NULL として扱う（NULL 可の列が無い場合）", () => {
    const b = new Uint8Array(14 + 4);
    const v = new DataView(b.buffer);
    v.setInt32(4, 1); // 1 行
    v.setInt16(8, 1); // 1 列
    v.setInt16(10, 0); // 指標なし
    v.setUint16(12, 4); // 行サイズ 4
    expect(parseResultData(b).nulls).toEqual([[false]]);
  });
});

describe("parseSqlca", () => {
  it("SQLCODE と SQLSTATE を固定位置から読む", () => {
    const b = new Uint8Array(136);
    new DataView(b.buffer).setInt32(12, -206);
    // SQLSTATE "42703" を CCSID 37 の EBCDIC で
    b.set([0xf4, 0xf2, 0xf7, 0xf0, 0xf3], 131);
    const ca = parseSqlca(b)!;
    expect(ca.sqlCode).toBe(-206);
    expect(ca.sqlState).toBe("42703");
  });

  it("短すぎる場合は undefined（解析全体を落とさない）", () => {
    expect(parseSqlca(new Uint8Array(10))).toBeUndefined();
  });
});
