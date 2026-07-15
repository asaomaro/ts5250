import { describe, it, expect } from "vitest";
import { codecForCcsid, DbcsCodec, SO, SI } from "../src/codec/codec.js";

const codec = codecForCcsid(1399) as DbcsCodec;

describe("DbcsCodec (ibm-1399)", () => {
  it("DBCS 対応コーデックを返す（930/939/1399＋エイリアス）", () => {
    expect(codec.isDbcs).toBe(true);
    expect((codecForCcsid(930) as DbcsCodec).isDbcs).toBe(true);
    expect((codecForCcsid(939) as DbcsCodec).isDbcs).toBe(true);
    expect((codecForCcsid(5035) as DbcsCodec).ccsid).toBe(939); // エイリアス
  });

  it("SBCS 部の英数字は 1 バイトで往復する", () => {
    const { bytes, substituted } = codec.encode("ABC123");
    expect(substituted).toBe(0);
    expect(bytes).toEqual(Uint8Array.from([0xc1, 0xc2, 0xc3, 0xf1, 0xf2, 0xf3]));
    expect(codec.decode(bytes)).toBe("ABC123");
  });

  it("日本語（DBCS）を SO/SI で囲んで 2 バイトエンコードし往復する", () => {
    const jp = "日本語";
    const { bytes, substituted } = codec.encode(jp);
    expect(substituted).toBe(0);
    expect(bytes[0]).toBe(SO); // 先頭 SO
    expect(bytes[bytes.length - 1]).toBe(SI); // 末尾 SI
    // SO + 3 文字×2 バイト + SI = 8 バイト
    expect(bytes.length).toBe(8);
    expect(codec.decode(bytes)).toBe(jp);
  });

  it("SBCS と DBCS の混在で SO/SI が最小限に挿入される", () => {
    const mixed = "A日B";
    const { bytes } = codec.encode(mixed);
    // A(1) SO 日(2) SI B(1) = 6 バイト
    expect(bytes.length).toBe(6);
    expect(codec.decode(bytes)).toBe(mixed);
  });

  it("連続する DBCS 文字は 1 組の SO/SI にまとめる", () => {
    const { bytes } = codec.encode("日本");
    // SO 日(2) 本(2) SI = 6 バイト（SO/SI は 1 組）
    expect(bytes.length).toBe(6);
    expect(bytes[0]).toBe(SO);
    expect(bytes[5]).toBe(SI);
  });

  it("マップ不能文字は SBCS SUB に置換し substituted に計上", () => {
    // サロゲート等マップ外の文字
    const { substituted } = codec.encode("A\u{1F600}B");
    expect(substituted).toBeGreaterThanOrEqual(1);
  });

  it("decode は SO/SI をまたぐバイト列を正しく畳む", () => {
    // A SO 日 SI B を手組み
    const jpBytes = [...codec.encode("日").bytes]; // SO xx xx SI
    const raw = Uint8Array.from([0xc1, ...jpBytes, 0xc2]);
    expect(codec.decode(raw)).toBe("A日B");
  });
});
