import { describe, it, expect } from "vitest";
import { parseLobLength } from "../src/hostserver/db/lob.js";

/**
 * LOB データ長（CP `0x3810`）の解析。
 *
 * 先頭 2 バイトが**長さの幅**を表すという非自明な形なので固定する
 * （0 なら長さなし / 4 なら 32 ビット / それ以外は上下 32 ビットで 64 ビット）。
 */
function lengthParam(width: number, ...values: number[]): Uint8Array {
  const b = new Uint8Array(width === 4 ? 6 : width === 0 ? 2 : 12);
  const v = new DataView(b.buffer);
  v.setUint16(0, width);
  if (width === 4) v.setUint32(2, values[0]!);
  else if (width !== 0) {
    v.setUint32(4, values[0]!);
    v.setUint32(8, values[1]!);
  }
  return b;
}

describe("parseLobLength", () => {
  it("幅 0 は長さなし", () => {
    expect(parseLobLength(lengthParam(0))).toBe(0);
  });

  it("幅 4 は 32 ビットで読む", () => {
    expect(parseLobLength(lengthParam(4, 163840))).toBe(163840);
  });

  it("幅 4 の最大値", () => {
    expect(parseLobLength(lengthParam(4, 0xffffffff))).toBe(0xffffffff);
  });

  it("それ以外は上下 32 ビットを繋いで読む", () => {
    // 上位 1・下位 0 → 2^32
    expect(parseLobLength(lengthParam(8, 1, 0))).toBe(4294967296);
    expect(parseLobLength(lengthParam(8, 0, 12345))).toBe(12345);
  });

  it("短すぎる本体でも例外にしない（長さは付加情報）", () => {
    expect(parseLobLength(Uint8Array.from([0, 4]))).toBe(0);
    expect(parseLobLength(Uint8Array.from([0, 8, 0, 0]))).toBe(0);
  });
});
