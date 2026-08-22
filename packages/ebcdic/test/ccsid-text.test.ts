import { describe, it, expect } from "vitest";
import {
  canDecodeCcsid,
  canEncodeCcsid,
  decodeCcsidText,
  encodeCcsidText,
  isEbcdicCcsid,
  TEXT_CCSIDS
} from "../src/ccsid-text.js";

/**
 * CCSID 指定の復号・符号化。
 * EBCDIC の期待値は **実機（PUB400）で往復させたバイト列**（research F5）。
 */
describe("復号（CCSID 指定）", () => {
  it("EBCDIC を同梱の表で読む", () => {
    // 実機で書いた `/home/USER/ifsdemo/ccsidprobe-37.txt` の中身
    const bytes = Uint8Array.from([
      0x88, 0x85, 0x93, 0x93, 0x96, 0x7c, 0xa6, 0x96, 0x99, 0x93, 0x84, 0x25
    ]);
    expect(decodeCcsidText(37, bytes)).toEqual({ text: "hello@world\n", newline: "lf" });
  });

  it("混在 DBCS（1399）を SO/SI ごと読む", () => {
    const bytes = Uint8Array.from([
      0x0e, 0x45, 0x62, 0x45, 0x66, 0x48, 0xe7, 0x43, 0x94, 0x43, 0x8e, 0x43, 0x95, 0x0f, 0x7c,
      0x81, 0x82, 0x83, 0x25
    ]);
    expect(decodeCcsidText(1399, bytes).text).toBe("日本語テスト@abc\n");
  });

  it("UTF-8 / ISO 8859-1 / UTF-16BE を TextDecoder に橋渡しする", () => {
    expect(decodeCcsidText(1208, new TextEncoder().encode("あa")).text).toBe("あa");
    expect(decodeCcsidText(819, Uint8Array.from([0x41, 0xe9])).text).toBe("Aé");
    expect(decodeCcsidText(1200, Uint8Array.from([0x30, 0x42])).text).toBe("あ");
  });

  it("その文字コードとして成立しないバイト列は例外（黙って U+FFFD にしない）", () => {
    expect(() => decodeCcsidText(1208, Uint8Array.from([0xc1, 0xc2]))).toThrow();
  });

  it("未対応の CCSID は例外", () => {
    // **850 / 437 は 2026-08-22 から読める**（同梱の表。`oem-tables.ts`）。
    // ここは「どの経路にも無い CCSID」で見る
    expect(() => decodeCcsidText(9999, Uint8Array.from([0x41]))).toThrow(RangeError);
    expect(canDecodeCcsid(9999)).toBe(false);
    expect(canDecodeCcsid(1399)).toBe(true);
    expect(canDecodeCcsid(819)).toBe(true);
    expect(canDecodeCcsid(850), "同梱の表で読める").toBe(true);
  });
});

describe("行末（EBCDIC の 0x15）", () => {
  it("0x15 の行を \\n に正規化し、nel と報告する", () => {
    // EDTF などが作る EBCDIC ファイル: 行末が 0x15（復号すると U+0085）
    const bytes = Uint8Array.from([0x81, 0x15, 0x82, 0x15]);
    expect(decodeCcsidText(37, bytes)).toEqual({ text: "a\nb\n", newline: "nel" });
  });

  it("0x25 の行はそのまま lf", () => {
    expect(decodeCcsidText(37, Uint8Array.from([0x81, 0x25]))).toEqual({
      text: "a\n",
      newline: "lf"
    });
  });

  it("混在は多い方を採る", () => {
    // 0x25 が 2 個、0x15 が 1 個 → lf 優勢。NEL はそのまま残す（勝手に改行にしない）
    const mixed = decodeCcsidText(37, Uint8Array.from([0x81, 0x25, 0x82, 0x25, 0x83, 0x15]));
    expect(mixed.newline).toBe("lf");
    expect(mixed.text).toBe("a\nb\nc");
  });

  it("UTF-8 の U+0085 は改行に変えない", () => {
    const text = decodeCcsidText(1208, new TextEncoder().encode("ab"));
    expect(text).toEqual({ text: "ab", newline: "lf" });
  });

  it("nel で符号化すると 0x15 に戻る（往復する）", () => {
    const original = Uint8Array.from([0x81, 0x15, 0x82, 0x15]);
    const decoded = decodeCcsidText(37, original);
    const { bytes } = encodeCcsidText(37, decoded.text, { newline: decoded.newline });
    expect([...bytes]).toEqual([...original]);
  });
});

describe("符号化（保存）", () => {
  it("EBCDIC へ往復する", () => {
    for (const [ccsid, text] of [
      [37, "hello@world\n"],
      [273, "Grüße@abc\n"],
      [1399, "日本語テスト@abc\n"]
    ] as const) {
      const { bytes, substituted } = encodeCcsidText(ccsid, text);
      expect(substituted).toBe(0);
      expect(decodeCcsidText(ccsid, bytes).text).toBe(text);
    }
  });

  it("UTF-8 / UTF-16BE / 単バイト系へ往復する", () => {
    for (const [ccsid, text] of [
      [1208, "あa\n"],
      [1200, "あa\n"],
      [819, "Aé\n"],
      [1252, "A€\n"]
    ] as const) {
      const { bytes } = encodeCcsidText(ccsid, text);
      expect(decodeCcsidText(ccsid, bytes).text).toBe(text);
    }
  });

  it("単バイト系でマップ不能な文字は SUB に落として件数を返す", () => {
    const { bytes, substituted } = encodeCcsidText(819, "A日");
    expect(substituted).toBe(1);
    expect([...bytes]).toEqual([0x41, 0x1a]);
  });

  it("Shift_JIS 系は読めるが書けない（保存は断る）", () => {
    expect(canDecodeCcsid(943)).toBe(true);
    expect(canEncodeCcsid(943)).toBe(false);
    expect(() => encodeCcsidText(943, "あ")).toThrow(RangeError);
  });

  it("書ける CCSID の判定", () => {
    expect(canEncodeCcsid(1399)).toBe(true);
    expect(canEncodeCcsid(819)).toBe(true);
    expect(canEncodeCcsid(1200)).toBe(true);
    expect(canEncodeCcsid(850), "単バイトなので逆引きで戻せる").toBe(true);
    expect(canEncodeCcsid(9999), "どの経路にも無い").toBe(false);
    expect(canEncodeCcsid(943), "多バイトなので読み取り専用").toBe(false);
  });
});

describe("候補一覧", () => {
  it("すべて復号できる CCSID である", () => {
    for (const c of TEXT_CCSIDS) expect(canDecodeCcsid(c.ccsid)).toBe(true);
  });

  /** 一覧は表を引き込まない別モジュールなので、実装とずれていないかを突き合わせる */
  it("writable の表示が実際の符号化可否と一致する", () => {
    for (const c of TEXT_CCSIDS) expect(canEncodeCcsid(c.ccsid)).toBe(c.writable);
  });

  it("EBCDIC かどうかを見分けられる", () => {
    expect(isEbcdicCcsid(1399)).toBe(true);
    expect(isEbcdicCcsid(1208)).toBe(false);
  });
});
