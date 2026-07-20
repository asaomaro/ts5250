import { describe, it, expect } from "vitest";
import {
  parseExtendedResultData,
  parseSuperExtendedDataFormat
} from "../src/hostserver/db/db-reply-ext.js";

/**
 * 超拡張データ形式（0x3812）と拡張結果データ（0x380E）の解析。
 *
 * **実機のバイト配置を固定する**のが目的。原典（JTOpen の
 * DBSuperExtendedDataFormat / DBExtendedData）から読み取った配置に基づく。
 */

/** 列 1 つぶんの繰り返し部（48 バイト）を組み立てる */
function column(opts: {
  sqlType: number;
  length: number;
  scale?: number;
  precision?: number;
  ccsid?: number;
  lobLocator?: number;
  lobMaxSize?: number;
  /** 可変長部へのオフセット（繰り返し部の基点から） */
  toVariable?: number;
  variableTotal?: number;
}): Uint8Array {
  const b = new Uint8Array(48);
  const v = new DataView(b.buffer);
  v.setUint16(2, opts.sqlType);
  v.setUint32(4, opts.length);
  v.setUint16(8, opts.scale ?? 0);
  v.setUint16(10, opts.precision ?? 0);
  v.setUint16(12, opts.ccsid ?? 0);
  v.setUint32(17, opts.lobLocator ?? 0);
  v.setUint32(26, opts.lobMaxSize ?? 0);
  v.setUint32(32, opts.toVariable ?? 0);
  v.setUint32(36, opts.variableTotal ?? 0);
  return b;
}

/** 列名を運ぶ可変長要素（LL CP CCSID 名前） */
function nameChunk(nameEbcdic: number[]): Uint8Array {
  const b = new Uint8Array(8 + nameEbcdic.length);
  const v = new DataView(b.buffer);
  v.setUint32(0, b.length);
  v.setUint16(4, 0x3840);
  v.setUint16(6, 37);
  b.set(nameEbcdic, 8);
  return b;
}

function format(columns: Uint8Array[], recordSize: number, tail = new Uint8Array(0)): Uint8Array {
  const fixed = new Uint8Array(16);
  const v = new DataView(fixed.buffer);
  v.setUint32(4, columns.length);
  v.setUint32(12, recordSize);
  const out = new Uint8Array(16 + columns.length * 48 + tail.length);
  out.set(fixed, 0);
  columns.forEach((c, i) => out.set(c, 16 + i * 48));
  out.set(tail, 16 + columns.length * 48);
  return out;
}

describe("parseSuperExtendedDataFormat", () => {
  it("列数とレコードサイズを読む", () => {
    const f = parseSuperExtendedDataFormat(format([column({ sqlType: 452, length: 10 })], 10));
    expect(f.columns).toHaveLength(1);
    expect(f.recordSize).toBe(10);
  });

  it("列のオフセットを長さの積み上げで求める（形式に含まれないため）", () => {
    const f = parseSuperExtendedDataFormat(
      format(
        [
          column({ sqlType: 452, length: 10 }),
          column({ sqlType: 496, length: 4 }),
          column({ sqlType: 452, length: 3 })
        ],
        17
      )
    );
    expect(f.columns.map((c) => c.offset)).toEqual([0, 10, 14]);
  });

  it("位取り・精度・CCSID を読む", () => {
    const f = parseSuperExtendedDataFormat(
      format([column({ sqlType: 484, length: 4, scale: 2, precision: 7, ccsid: 273 })], 4)
    );
    expect(f.columns[0]).toMatchObject({ scale: 2, precision: 7, ccsid: 273 });
  });

  it("LOB のロケーターと最大サイズを読む", () => {
    const f = parseSuperExtendedDataFormat(
      format([column({ sqlType: 964, length: 4, lobLocator: 0x1234, lobMaxSize: 2_097_152 })], 4)
    );
    expect(f.columns[0]!.lobLocator).toBe(0x1234);
    expect(f.columns[0]!.lobMaxSize).toBe(2_097_152);
  });

  it("可変長部から列名を読む（CP 0x3840）", () => {
    // EBCDIC "AB" = 0xC1 0xC2
    const chunk = nameChunk([0xc1, 0xc2]);
    const col = column({ sqlType: 452, length: 2, toVariable: 48, variableTotal: chunk.length });
    expect(parseSuperExtendedDataFormat(format([col], 2, chunk)).columns[0]!.name).toBe("AB");
  });

  it("**列名が見つからなくても例外にしない**（式の結果列には名前が無い）", () => {
    const f = parseSuperExtendedDataFormat(format([column({ sqlType: 452, length: 2 })], 2));
    expect(f.columns[0]!.name).toBe("");
  });

  it("短すぎる形式は拒否する", () => {
    expect(() => parseSuperExtendedDataFormat(new Uint8Array(8))).toThrow(/too short/);
  });

  it("列数に対して足りない長さは拒否する（黙って欠けた列を返さない）", () => {
    const short = format([column({ sqlType: 452, length: 2 })], 2).subarray(0, 40);
    expect(() => parseSuperExtendedDataFormat(short)).toThrow(/truncated/);
  });
});

/** 拡張結果データを組み立てる */
function resultData(opts: {
  rowCount: number;
  columnCount: number;
  indicatorSize: number;
  rowSize: number;
  indicators?: number[];
  rows?: number[][];
}): Uint8Array {
  const { rowCount, columnCount, indicatorSize, rowSize } = opts;
  const total = 20 + rowCount * (columnCount * indicatorSize + rowSize);
  const b = new Uint8Array(total);
  const v = new DataView(b.buffer);
  v.setUint32(4, rowCount);
  v.setUint16(8, columnCount);
  v.setUint16(10, indicatorSize);
  v.setUint32(16, rowSize);
  (opts.indicators ?? []).forEach((ind, i) => v.setInt16(20 + i * indicatorSize, ind));
  const dataAt = 20 + rowCount * columnCount * indicatorSize;
  (opts.rows ?? []).forEach((row, r) => b.set(row, dataAt + r * rowSize));
  return b;
}

describe("parseExtendedResultData", () => {
  it("行を切り出す", () => {
    const d = parseExtendedResultData(
      resultData({
        rowCount: 2,
        columnCount: 1,
        indicatorSize: 2,
        rowSize: 3,
        rows: [
          [1, 2, 3],
          [4, 5, 6]
        ]
      })
    );
    expect(d.rows).toHaveLength(2);
    expect([...d.rows[0]!]).toEqual([1, 2, 3]);
    expect([...d.rows[1]!]).toEqual([4, 5, 6]);
  });

  it("負の指標を NULL として読む", () => {
    const d = parseExtendedResultData(
      resultData({
        rowCount: 2,
        columnCount: 2,
        indicatorSize: 2,
        rowSize: 2,
        indicators: [0, -1, -1, 0]
      })
    );
    expect(d.nulls).toEqual([
      [false, true],
      [true, false]
    ]);
  });

  it("指標サイズ 0 なら全て非 NULL", () => {
    const d = parseExtendedResultData(
      resultData({ rowCount: 1, columnCount: 2, indicatorSize: 0, rowSize: 2 })
    );
    expect(d.nulls).toEqual([[false, false]]);
  });

  it("0 行でも壊れない", () => {
    const d = parseExtendedResultData(
      resultData({ rowCount: 0, columnCount: 1, indicatorSize: 2, rowSize: 4 })
    );
    expect(d.rows).toHaveLength(0);
  });

  it("短すぎるデータは拒否する", () => {
    expect(() => parseExtendedResultData(new Uint8Array(10))).toThrow(/too short/);
  });

  it("宣言より短い本体は拒否する（黙って欠けた行を返さない）", () => {
    const full = resultData({ rowCount: 2, columnCount: 1, indicatorSize: 2, rowSize: 8 });
    expect(() => parseExtendedResultData(full.subarray(0, full.length - 4))).toThrow(/truncated/);
  });
});
