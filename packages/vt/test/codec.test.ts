import { describe, it, expect } from "vitest";
import { VtDecoder, encodeText, reverseTableSize, isVtEncoding } from "../src/text/codec.js";

const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, "0")).join(" ");

describe("復号", () => {
  it("UTF-8 の日本語", () => {
    const d = new VtDecoder("utf-8");
    expect(d.decode(Uint8Array.of(0xe3, 0x81, 0x82, 0xe3, 0x81, 0x84))).toBe("あい");
  });

  it("**多バイトが分割到着しても繋ぐ**（TCP の境界で割れる）", () => {
    const d = new VtDecoder("utf-8");
    // 「あ」= e3 81 82 を 1 バイトずつ渡す
    expect(d.decode(Uint8Array.of(0xe3))).toBe("");
    expect(d.decode(Uint8Array.of(0x81))).toBe("");
    expect(d.decode(Uint8Array.of(0x82))).toBe("あ");
  });

  it("Shift_JIS / EUC-JP も標準の復号で読める", () => {
    // 実測: iconv で作った「あいう」（research 2.2）
    expect(new VtDecoder("shift_jis").decode(Uint8Array.of(0x82, 0xa0, 0x82, 0xa2, 0x82, 0xa4)))
      .toBe("あいう");
    expect(new VtDecoder("euc-jp").decode(Uint8Array.of(0xa4, 0xa2, 0xa4, 0xa4, 0xa4, 0xa6)))
      .toBe("あいう");
  });

  it("**不正なバイトで例外にしない**（U+FFFD に落として続ける）", () => {
    const d = new VtDecoder("utf-8");
    const s = d.decode(Uint8Array.of(0x41, 0xff, 0xfe, 0x42));
    expect(s.startsWith("A")).toBe(true);
    expect(s.endsWith("B")).toBe(true);
    expect(s).toContain("�");
  });
});

describe("符号化（逆引き表は実行時に組む）", () => {
  it("UTF-8 はそのまま", () => {
    expect(hex(encodeText("あA", "utf-8").bytes)).toBe("e3 81 82 41");
  });

  it("Shift_JIS へ戻せる（復号と往復する）", () => {
    const r = encodeText("あいう|ABC", "shift_jis");
    expect(hex(r.bytes)).toBe("82 a0 82 a2 82 a4 7c 41 42 43");
    expect(r.dropped).toEqual([]);
  });

  it("EUC-JP へ戻せる", () => {
    expect(hex(encodeText("あいう", "euc-jp").bytes)).toBe("a4 a2 a4 a4 a4 a6");
  });

  it("**ASCII は 1 バイトのまま**（短い列が優先される）", () => {
    expect(hex(encodeText("Az0 ", "shift_jis").bytes)).toBe("41 7a 30 20");
  });

  it("半角カナも通る（Shift_JIS の 1 バイト領域）", () => {
    expect(hex(encodeText("ｱｲ", "shift_jis").bytes)).toBe("b1 b2");
  });

  it("**表せない字は ? に落とし、落としたことを返す**（黙って消さない）", () => {
    const r = encodeText("A😀B", "shift_jis");
    expect(hex(r.bytes)).toBe("41 3f 42");
    expect(r.dropped).toEqual(["😀"]);
  });

  it("同じ字を何度落としても報告は 1 回", () => {
    expect(encodeText("😀😀😀", "shift_jis").dropped).toEqual(["😀"]);
  });

  it("iso-2022-jp は**受信専用**として断る（状態を持つ符号化で打鍵に向かない）", () => {
    expect(() => encodeText("あ", "iso-2022-jp")).toThrow(/受信専用/u);
  });

  it("表は実用的な規模になる（数千字以上）", () => {
    expect(reverseTableSize("shift_jis")).toBeGreaterThan(6000);
    expect(reverseTableSize("euc-jp")).toBeGreaterThan(6000);
  });
});

describe("符号化名", () => {
  it("知っている名前だけ通す", () => {
    expect(isVtEncoding("utf-8")).toBe(true);
    expect(isVtEncoding("shift_jis")).toBe(true);
    expect(isVtEncoding("cp932")).toBe(false);
  });
});
