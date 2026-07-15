import { describe, it, expect } from "vitest";
import { SbcsCodec, codecForCcsid } from "../src/codec/codec.js";

const codec = codecForCcsid(37);

describe("SbcsCodec (ibm-37)", () => {
  it("既知のコードポイントを双方向変換できる", () => {
    // EBCDIC の代表値: 'A'=0xC1, 'a'=0x81, '0'=0xF0, space=0x40, '$'=0x5B
    expect(codec.decode(Uint8Array.from([0xc1, 0x81, 0xf0, 0x40, 0x5b]))).toBe("Aa0 $");
    const { bytes, substituted } = codec.encode("Aa0 $");
    expect([...bytes]).toEqual([0xc1, 0x81, 0xf0, 0x40, 0x5b]);
    expect(substituted).toBe(0);
  });

  it("ASCII 英数字がラウンドトリップする", () => {
    const text = "HELLO WORLD 0123456789 hello.,-/()&?!";
    const { bytes, substituted } = codec.encode(text);
    expect(substituted).toBe(0);
    expect(codec.decode(bytes)).toBe(text);
  });

  it("マップ不能文字は SUB に置換し置換数を返す", () => {
    const { bytes, substituted } = codec.encode("Aあ");
    expect(bytes[0]).toBe(0xc1);
    expect(bytes[1]).toBe(0x3f); // SUB
    expect(substituted).toBe(1);
  });

  it("全 256 バイトの decode が桁を落とさない", () => {
    const all = new Uint8Array(256).map((_, i) => i);
    expect(codec.decode(all)).toHaveLength(256);
  });

  it("未対応 CCSID は明示的に拒否する", () => {
    expect(() => codecForCcsid(500)).toThrow(/unsupported CCSID/);
    expect(() => codecForCcsid(9999)).toThrow(/unsupported CCSID/);
  });

  it("decodeByte は未定義バイトで U+FFFD を返す", () => {
    const table = {
      ccsid: 999,
      name: "test",
      ebcdicToUnicode: new Uint16Array(256).fill(0xfffd),
      unicodeToEbcdic: new Map<number, number>(),
      sub: 0x3f
    };
    const c = new SbcsCodec(table);
    expect(c.decodeByte(0x00)).toBe(0xfffd);
  });
});
