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

/**
 * **930/939 の DBCS 部は CCSID 300**（16684 を使うのは 1399 だけ）。
 * ICU の ucm は 300 の 5 文字を Unicode 規格寄り（U+2212 等）に割り当てるが、
 * ACS / jt400（ConvTable300）は全角形（U+FF0D 等）を返す。ACS と同じ結果を正とする。
 *
 * 見た目にも効く——全角形は East Asian Width が Fullwidth でどのフォントでも 2 桁だが、
 * U+2212 等は Ambiguous で欧文等幅フォントが 1 桁に描き、桁がずれる
 * （実機の PDM F1 ヘルプ「オプション−ヘルプ」で実測）。
 */
describe("CCSID 300 の Unicode 割り当て（930/939 の DBCS 部）", () => {
  const cases: ReadonlyArray<readonly [number, number]> = [
    [0x4260, 0xff0d], // －
    [0x426a, 0xffe4], // ￤
    [0x43a1, 0xff5e], // ～
    [0x444a, 0x2015], // ―
    [0x447c, 0x2225] // ‖
  ];

  for (const ccsid of [930, 939]) {
    it(`CCSID ${ccsid} は ACS と同じ全角形にデコードする`, () => {
      const c = codecForCcsid(ccsid);
      for (const [pair, cp] of cases) {
        expect(c.decodeDbcsPair!(pair >> 8, pair & 0xff)).toBe(cp);
        // 逆方向は元から同じバイト対へ寄るので往復する
        expect(c.encodeDbcsChar!(cp)).toBe(pair);
      }
    });
  }

  it("CCSID 1399（DBCS 部は 16684）は差し替えない", () => {
    const c = codecForCcsid(1399);
    expect(c.decodeDbcsPair!(0x42, 0x60)).toBe(0x2212);
    expect(c.decodeDbcsPair!(0x43, 0xa1)).toBe(0x301c);
    // 16684 には全角形が別の符号位置で存在する
    expect(c.decodeDbcsPair!(0xe9, 0xf3)).toBe(0xff0d);
  });
});
