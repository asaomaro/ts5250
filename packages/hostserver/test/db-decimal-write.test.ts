import { describe, it, expect } from "vitest";
import {
  packedByteLength,
  packedDecimalToString,
  zonedDecimalToString,
  stringToPackedDecimal,
  stringToZonedDecimal
} from "../src/db/db-decimal.js";

/**
 * **10 進数を書く向き**（プログラム呼び出しの入力パラメータ用）。
 *
 * 符号ニブルの位置と奇数桁の詰め方は取り違えやすく、**間違えても
 * 「それらしいバイト列」になる**ので気づきにくい。だから**往復**で固定する
 * ——読む向きは既に実機で使われているので、往復が合えば書く向きも正しい。
 */
describe("パック 10 進数を書く", () => {
  const trip = (text: string, digits: number, scale: number): string =>
    packedDecimalToString(stringToPackedDecimal(text, digits, scale), 0, digits, scale);

  it("**往復して値が変わらない**", () => {
    expect(trip("123.45", 5, 2)).toBe("123.45");
    expect(trip("-123.45", 5, 2)).toBe("-123.45");
    expect(trip("0", 5, 2)).toBe("0.00");
    expect(trip("7", 15, 5)).toBe("7.00000");
    expect(trip("-0.01", 5, 2)).toBe("-0.01");
  });

  it("**奇数桁でも偶数桁でも合う**（詰め方を取り違えない）", () => {
    for (const d of [1, 2, 3, 4, 5, 7, 9, 15, 31]) {
      expect(trip("1", d, 0), `${d} 桁`).toBe("1");
      expect(trip("-1", d, 0), `${d} 桁`).toBe("-1");
    }
  });

  it("バイト長が読む向きと一致する", () => {
    for (const d of [1, 2, 5, 15, 31]) {
      expect(stringToPackedDecimal("1", d, 0)).toHaveLength(packedByteLength(d));
    }
  });

  it("**符号ニブルは最終バイトの下位**", () => {
    expect(stringToPackedDecimal("1", 1, 0)[0]! & 0x0f).toBe(0x0f);
    expect(stringToPackedDecimal("-1", 1, 0)[0]! & 0x0f).toBe(0x0d);
  });

  it("**桁があふれたら拒否**（黙って落とさない）", () => {
    expect(() => stringToPackedDecimal("123456", 5, 0)).toThrowError();
  });

  it("**丸めが必要なら拒否**（黙って値を変えない）", () => {
    expect(() => stringToPackedDecimal("1.239", 5, 2)).toThrowError();
    // 落ちるのが 0 だけなら通す（値が変わらないため）
    expect(trip("1.230", 5, 2)).toBe("1.23");
  });

  it("数値として読めなければ拒否", () => {
    for (const bad of ["", "abc", "1.2.3", "--1"]) {
      expect(() => stringToPackedDecimal(bad, 5, 2), bad).toThrowError();
    }
  });
});

describe("ゾーン 10 進数を書く", () => {
  const trip = (text: string, digits: number, scale: number): string =>
    zonedDecimalToString(stringToZonedDecimal(text, digits, scale), 0, digits, scale);

  it("**往復して値が変わらない**", () => {
    expect(trip("123.45", 5, 2)).toBe("123.45");
    expect(trip("-123.45", 5, 2)).toBe("-123.45");
    expect(trip("0", 3, 0)).toBe("0");
  });

  it("**1 バイト 1 桁**（パックと長さが違う）", () => {
    expect(stringToZonedDecimal("123", 3, 0)).toHaveLength(3);
    expect(stringToPackedDecimal("123", 3, 0)).toHaveLength(2);
  });

  it("**符号は最終バイトの上位ニブル**（パックと位置が違う）", () => {
    expect((stringToZonedDecimal("1", 1, 0)[0]! >> 4) & 0x0f).toBe(0x0f);
    expect((stringToZonedDecimal("-1", 1, 0)[0]! >> 4) & 0x0f).toBe(0x0d);
  });
});
