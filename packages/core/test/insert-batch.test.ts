import { describe, it, expect } from "vitest";
import { batchSizeFor, DEFAULT_MAX_BATCH_BYTES } from "../src/hostserver/db/insert.js";
import { markerDataSize } from "../src/hostserver/db/marker-encode.js";
import type { MarkerFormat } from "../src/hostserver/db/marker-format.js";
import { DB2 } from "../src/hostserver/db/db-types.js";

/**
 * バッチ分割。**1 バッチ = 1 往復**なので、ここが往復数を決める。
 * 上限値そのものは実機で詰めるが、計算の性質は実機なしで固められる。
 */
function fmt(rowSize: number, columns: number): MarkerFormat {
  const fields = Array.from({ length: columns }, (_, i) => ({
    sqlType: DB2.CHAR,
    length: rowSize / columns,
    scale: 0,
    precision: 0,
    ccsid: 37,
    offset: (i * rowSize) / columns
  }));
  return { fields, rowSize, raw: new Uint8Array(0) };
}

describe("batchSizeFor", () => {
  it("上限に収まる行数を返す", () => {
    const f = fmt(100, 2); // 1 行 = 100 + 指標 4 = 104 バイト
    const n = batchSizeFor(f, 20 + 104 * 10);
    expect(n).toBe(10);
    expect(markerDataSize(f, n)).toBeLessThanOrEqual(20 + 104 * 10);
  });

  it("**最低 1 行は送る**（0 だと進まなくなる）", () => {
    const f = fmt(10_000, 1);
    expect(batchSizeFor(f, 100)).toBe(1);
    expect(batchSizeFor(f, 0)).toBe(1);
  });

  it("列が増えると指標のぶん 1 行が重くなる", () => {
    const few = batchSizeFor(fmt(100, 1), 100_000);
    const many = batchSizeFor(fmt(100, 50), 100_000);
    expect(many).toBeLessThan(few);
  });

  it("既定の上限で実用的な行数が入る", () => {
    // 60 バイト・4 列（スパイクで使った表と同じ形）
    const n = batchSizeFor(fmt(60, 4), DEFAULT_MAX_BATCH_BYTES);
    expect(n).toBeGreaterThan(1000);
  });

  it("計算した行数が本当に上限に収まる（境界）", () => {
    const f = fmt(37, 3);
    for (const max of [500, 1000, 4096, 65_536]) {
      const n = batchSizeFor(f, max);
      expect(markerDataSize(f, n)).toBeLessThanOrEqual(Math.max(max, markerDataSize(f, 1)));
    }
  });
});
