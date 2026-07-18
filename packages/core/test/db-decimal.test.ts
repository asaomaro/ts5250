import { describe, it, expect } from "vitest";
import {
  packedDecimalToString,
  zonedDecimalToString,
  packedByteLength
} from "../src/hostserver/db/db-decimal.js";
import { Tn5250Error } from "../src/errors.js";

/**
 * 10 進数は number を経由せず文字列にする（2^53 超・金額の精度を落とさないため）。
 *
 * **符号の位置がパックとゾーンで違う**ため、両方を並べて取り違えを防ぐ:
 *   パック … 最終バイトの【下位】ニブル
 *   ゾーン … 最終バイトの【上位】ニブル
 */
const b = (...v: number[]): Uint8Array => Uint8Array.from(v);

describe("packedDecimalToString（パック 10 進数）", () => {
  it("実機テスト表の値: DECIMAL(11,2) の -12345678.91", () => {
    // 11 桁 "01234567891" → ニブル 0,1,2,3,4,5,6,7,8,9,1 ＋ 符号 D(負)
    expect(packedDecimalToString(b(0x01, 0x23, 0x45, 0x67, 0x89, 0x1d), 0, 11, 2)).toBe(
      "-12345678.91"
    );
  });

  it("同じバイト列でも符号ニブルが C なら正", () => {
    expect(packedDecimalToString(b(0x01, 0x23, 0x45, 0x67, 0x89, 0x1c), 0, 11, 2)).toBe(
      "12345678.91"
    );
  });

  it("符号 F も正として扱う（未署名の表現）", () => {
    expect(packedDecimalToString(b(0x12, 0x3f), 0, 3, 0)).toBe("123");
  });

  it("符号 B は負", () => {
    expect(packedDecimalToString(b(0x12, 0x3b), 0, 3, 0)).toBe("-123");
  });

  it("小数点以下が無い場合は整数のまま", () => {
    expect(packedDecimalToString(b(0x12, 0x3c), 0, 3, 0)).toBe("123");
  });

  it("前置ゼロを落とす", () => {
    expect(packedDecimalToString(b(0x00, 0x1c), 0, 3, 0)).toBe("1");
  });

  it("整数部がゼロなら 0 を残す", () => {
    expect(packedDecimalToString(b(0x00, 0x1c), 0, 3, 2)).toBe("0.01");
  });

  it("ゼロは符号が負でも -0 にしない", () => {
    expect(packedDecimalToString(b(0x00, 0x0d), 0, 3, 0)).toBe("0");
    expect(packedDecimalToString(b(0x00, 0x0d), 0, 3, 2)).toBe("0.00");
  });

  it("桁数が偶数のときも読める（先頭に 0 が入る扱い）", () => {
    // 4 桁 → 奇数(5)へ切り上げ → 3 バイト。"01234" の下 4 桁
    expect(packedDecimalToString(b(0x01, 0x23, 0x4c), 0, 4, 0)).toBe("1234");
  });

  it("offset を尊重する", () => {
    expect(packedDecimalToString(b(0xff, 0xff, 0x12, 0x3c), 2, 3, 0)).toBe("123");
  });

  it("範囲外は PROTOCOL_ERROR", () => {
    expect(() => packedDecimalToString(b(0x12), 0, 11, 2)).toThrow(Tn5250Error);
    expect(() => packedDecimalToString(b(0x12), 0, 11, 2)).toThrow(/out of range/);
  });
});

describe("packedByteLength", () => {
  it("桁数を奇数へ切り上げてから /2 + 1", () => {
    expect(packedByteLength(11)).toBe(6);
    expect(packedByteLength(4)).toBe(3);
    expect(packedByteLength(1)).toBe(1);
    expect(packedByteLength(2)).toBe(2);
  });
});

describe("zonedDecimalToString（ゾーン 10 進数）", () => {
  it("実機テスト表の値: NUMERIC(7,3) の 1.234", () => {
    // 7 バイト。各バイト下位ニブルが数字、最終バイトの【上位】ニブルが符号 C(正)
    expect(zonedDecimalToString(b(0xf0, 0xf0, 0xf0, 0xf1, 0xf2, 0xf3, 0xc4), 0, 7, 3)).toBe(
      "1.234"
    );
  });

  it("最終バイトの上位ニブルが D なら負（パックとは符号位置が違う）", () => {
    expect(zonedDecimalToString(b(0xf1, 0xf2, 0xd3), 0, 3, 0)).toBe("-123");
  });

  it("上位ニブル F は正", () => {
    expect(zonedDecimalToString(b(0xf1, 0xf2, 0xf3), 0, 3, 0)).toBe("123");
  });

  it("1 バイト 1 桁で読む", () => {
    expect(zonedDecimalToString(b(0xf9, 0xf8, 0xf7, 0xc6), 0, 4, 2)).toBe("98.76");
  });

  it("前置ゼロを落とす", () => {
    expect(zonedDecimalToString(b(0xf0, 0xf0, 0xc5), 0, 3, 0)).toBe("5");
  });

  it("ゼロは -0 にしない", () => {
    expect(zonedDecimalToString(b(0xf0, 0xf0, 0xd0), 0, 3, 0)).toBe("0");
  });

  it("範囲外は PROTOCOL_ERROR", () => {
    expect(() => zonedDecimalToString(b(0xf1), 0, 7, 3)).toThrow(/out of range/);
  });
});

describe("パックとゾーンの符号位置の違い（取り違え防止）", () => {
  it("同じ最終バイト 0xD3 でも、パックは下位・ゾーンは上位を符号として見る", () => {
    // パック: 下位ニブル 3 は符号ではなく正扱い（0x3 は負リストに無い）→ 数字として 12,D は…
    // ここでは意図を明示するため、それぞれの解釈が異なることだけを固定する
    const packed = packedDecimalToString(b(0x12, 0xd3), 0, 3, 0); // 下位 3 → 正
    const zoned = zonedDecimalToString(b(0xf1, 0xf2, 0xd3), 0, 3, 0); // 上位 D → 負
    expect(packed.startsWith("-")).toBe(false);
    expect(zoned.startsWith("-")).toBe(true);
  });
});
