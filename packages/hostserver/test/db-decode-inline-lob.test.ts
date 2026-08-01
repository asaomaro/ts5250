import { describe, it, expect } from "vitest";
import { decodeValue, toColumnMeta, type ColumnMeta } from "../src/db/db-decode.js";
import type { LobPlaceholder } from "../src/db/db-decode.js";
import { DB2 } from "../src/db/db-types.js";

/**
 * **ロケーターではない LOB**（行データに載って届くもの）の復号。
 *
 * 接続時の LOB フィールドしきい値（`DbConnectOptions.lobFieldThreshold`）以下の LOB は、
 * ロケーターではなく本体が行に載って来る。既定（0）では現れないので、
 * **実機（IBM i 7.3）で採った形をここに固定する**
 * （`scripts/research-lob-threshold.mjs` / `20260801-lob-threshold-realhost`）。
 *
 * 実機で確認した並び:
 * - CLOB / BLOB … `4 バイトの【バイト数】` ＋ 本体
 * - DBCLOB …… `4 バイトの【文字数】` ＋ 本体（バイト数はその 2 倍）
 * - 列の `length` は「宣言した最大 ＋ 4」（CLOB(1K) で 1028 / DBCLOB(1K) で 2052）
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

/**
 * 行バッファは**宣言幅ぶん丸ごと**来る（`assertRange`）。テストでも幅を合わせる
 * ——短く作ると「範囲外」で落ちて、測りたい復号まで届かない。
 */
const row = (length: number, ...v: number[]): Uint8Array => {
  const b = new Uint8Array(length);
  b.set(v.slice(0, length));
  return b;
};
const lob = (v: unknown): LobPlaceholder => v as LobPlaceholder;

describe("インライン CLOB", () => {
  it("4 バイトのバイト数の後ろを読む", () => {
    // EBCDIC 273 で "AB" = 0xC1 0xC2
    const m = meta({ type: DB2.CLOB, offset: 0, length: 8, ccsid: 273 });
    const got = lob(decodeValue(row(8, 0, 0, 0, 2, 0xc1, 0xc2, 0x40, 0x40), m, false));
    expect(got.kind).toBe("lob");
    expect(got.value).toBe("AB");
    expect(got.byteLength).toBe(2);
  });

  it("ロケーターは 0（インラインなので取り直す先が無い）", () => {
    const m = meta({ type: DB2.CLOB, offset: 0, length: 8, ccsid: 273 });
    const got = lob(decodeValue(row(8, 0, 0, 0, 1, 0xc1), m, false));
    expect(got.locator).toBe(0);
    // 取れているので未取得の理由は付かない
    expect(got.unavailable).toBeUndefined();
  });

  it("長さ 0 は空文字（NULL とは別物）", () => {
    const m = meta({ type: DB2.CLOB, offset: 0, length: 8, ccsid: 273 });
    expect(lob(decodeValue(row(8, 0, 0, 0, 0), m, false)).value).toBe("");
    expect(decodeValue(row(8, 0, 0, 0, 0), m, true)).toBeNull();
  });

  it("宣言した長さを超える長さは撥ねる（以降の列がずれるより落ちる方が良い）", () => {
    // length=8 なら本体に使えるのは 4 バイト。5 を宣言されたら壊れている
    const m = meta({ type: DB2.CLOB, offset: 0, length: 8, ccsid: 273 });
    expect(() => decodeValue(row(8, 0, 0, 0, 5, 0xc1, 0xc2, 0xc3, 0xc4), m, false)).toThrow(/only 4 bytes/);
  });
});

describe("インライン BLOB", () => {
  it("バイト列のまま返す（文字に直さない）", () => {
    const m = meta({ type: DB2.BLOB, offset: 0, length: 8, ccsid: 65535 });
    const got = lob(decodeValue(row(8, 0, 0, 0, 3, 0x01, 0x02, 0xff, 0x00), m, false));
    expect(got.value).toBeInstanceOf(Uint8Array);
    expect([...(got.value as Uint8Array)]).toEqual([0x01, 0x02, 0xff]);
    expect(got.byteLength).toBe(3);
  });
});

describe("インライン DBCLOB", () => {
  /**
   * **接頭辞は文字数**。バイト数として読むと `日本語`（3 文字 / 6 バイト）が
   * `日` になる——実機で実際に踏んだ（CCSID 1200 の DBCLOB）。
   */
  it("接頭辞は文字数（バイト数はその 2 倍）", () => {
    const m = meta({ type: DB2.DBCLOB, offset: 0, length: 10, ccsid: 1200 });
    // UTF-16BE で "日本語" = 65E5 672C 8A9E
    const got = lob(
      decodeValue(row(10, 0, 0, 0, 3, 0x65, 0xe5, 0x67, 0x2c, 0x8a, 0x9e), m, false)
    );
    expect(got.value).toBe("日本語");
    expect(got.byteLength).toBe(6);
  });

  it("文字数をバイト数と取り違えていない（半分で切れない）", () => {
    const m = meta({ type: DB2.DBCLOB, offset: 0, length: 16, ccsid: 1200 });
    // "全角混在ab" = 6 文字。ab も UTF-16 では 2 バイトずつ入る
    const got = lob(
      decodeValue(
        row(16, 0, 0, 0, 6, 0x51, 0x68, 0x89, 0xd2, 0x6d, 0xf7, 0x57, 0x28, 0x00, 0x61, 0x00, 0x62),
        m,
        false
      )
    );
    expect(got.value).toBe("全角混在ab");
    expect(got.byteLength).toBe(12);
  });
});
