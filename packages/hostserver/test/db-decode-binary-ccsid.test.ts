import { describe, it, expect } from "vitest";
import { decodeValue, toColumnMeta, type ColumnMeta } from "../src/db/db-decode.js";
import { DB2 } from "../src/db/db-types.js";

/**
 * CCSID 65535（＝変換しない）の**文字列列**の回帰。
 *
 * `20260802-sql-visual-explain` の research F8: DB モニターの表（`QQJFLD` / `QXC43` が
 * `CHAR` の 65535）へ `SELECT *` すると `RangeError: unsupported CCSID 65535` が素通りしていた。
 * `decodeLobBytes` は `isBinaryCcsid` を通していたのに、**文字列列だけ取り残されていた**。
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

describe("バイナリ CCSID の文字列列", () => {
  it("CHAR / CCSID 65535 は例外にならず 16 進の大文字で返る", () => {
    const m = meta({ type: DB2.CHAR, offset: 0, length: 4, ccsid: 65535 });
    expect(decodeValue(buf(0x00, 0xab, 0xff, 0x0f), m, false)).toBe("00ABFF0F");
  });

  it("VARCHAR / CCSID 65535 も 16 進で返る（長さは先頭 2 バイト）", () => {
    const m = meta({ type: DB2.VARCHAR, offset: 0, length: 10, ccsid: 65535 });
    expect(decodeValue(buf(0x00, 0x03, 0x12, 0x34, 0x56, 0, 0, 0, 0, 0), m, false)).toBe("123456");
  });

  it("CCSID 0（未設定）も同じ扱い", () => {
    const m = meta({ type: DB2.CHAR, offset: 0, length: 2, ccsid: 0 });
    expect(decodeValue(buf(0xde, 0xad), m, false)).toBe("DEAD");
  });

  it("空のバイト列は空文字（例外にしない）", () => {
    const m = meta({ type: DB2.VARCHAR, offset: 0, length: 4, ccsid: 65535 });
    expect(decodeValue(buf(0x00, 0x00, 0, 0), m, false)).toBe("");
  });

  it("**既存の CCSID は従来どおり文字列**（16 進化に巻き込まれていない）", () => {
    // EBCDIC 273 の 0xC1 0xC2 = "AB"
    const m = meta({ type: DB2.CHAR, offset: 0, length: 2, ccsid: 273 });
    expect(decodeValue(buf(0xc1, 0xc2), m, false)).toBe("AB");
  });

  it("NULL 指標が優先される（16 進にしない）", () => {
    const m = meta({ type: DB2.CHAR, offset: 0, length: 2, ccsid: 65535 });
    expect(decodeValue(buf(0xde, 0xad), m, true)).toBeNull();
  });
});
