import { describe, it, expect } from "vitest";
import { desEncryptBlock } from "../src/hostserver/des.js";

/**
 * DES エンジン単体の検証。**FIPS 46-3 / 公開の既知解テスト（KAT）ベクタ**で固定する。
 * これが正しいことと、`hostserver-password.test.ts` の参照実装差分ベクタが通ることで、
 * DES 経路（パスワードレベル 0/1）の正しさを二重に担保する。
 */
const hb = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s, "hex"));
const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

describe("desEncryptBlock", () => {
  it("教科書ベクタ: key=133457799BBCDFF1 pt=0123456789ABCDEF → 85E813540F0AB405", () => {
    expect(hex(desEncryptBlock(hb("133457799BBCDFF1"), hb("0123456789ABCDEF")))).toBe("85e813540f0ab405");
  });

  it("FIPS KAT: key=0101010101010101 pt=8000000000000000 → 95F8A5E5DD31D900", () => {
    expect(hex(desEncryptBlock(hb("0101010101010101"), hb("8000000000000000")))).toBe("95f8a5e5dd31d900");
  });

  it("FIPS KAT: 全ゼロ鍵・全ゼロ平文 → 8CA64DE9C1B123A7", () => {
    expect(hex(desEncryptBlock(hb("0000000000000000"), hb("0000000000000000")))).toBe("8ca64de9c1b123a7");
  });

  it("鍵のパリティビット（最下位ビット）は無視される（標準どおり）", () => {
    // 0x01 と 0x00 はパリティビットだけ違う → 同じ暗号文
    const a = desEncryptBlock(hb("0101010101010101"), hb("0123456789abcdef"));
    const b = desEncryptBlock(hb("0000000000000000"), hb("0123456789abcdef"));
    expect(hex(a)).toBe(hex(b));
  });

  it("8 バイト以外は拒否する", () => {
    expect(() => desEncryptBlock(new Uint8Array(7), new Uint8Array(8))).toThrow(/8 bytes/);
    expect(() => desEncryptBlock(new Uint8Array(8), new Uint8Array(9))).toThrow(/8 bytes/);
  });
});
