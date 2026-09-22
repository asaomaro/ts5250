import { describe, it, expect } from "vitest";
import { deviceEnvFor } from "../src/device-env.js";

/**
 * **`tn5250` / `tn3270` / `vt` が同じ表を見る**ようになったので、値の固定はここに 1 つだけ置く。
 * 以前は tn5250 と tn3270 に同じ期待値が別々に書かれていた。
 */
describe("RFC 2877 のデバイス属性", () => {
  it("英語（37）と、pub400 の既定（273）", () => {
    expect(deviceEnvFor(37)).toEqual({ kbdType: "USB", codePage: 37, charSet: 697 });
    expect(deviceEnvFor(273)).toEqual({ kbdType: "AGB", codePage: 273, charSet: 697 });
  });

  it("**日本語 DBCS は SBCS 部を申告する**（DBCS の CCSID をそのまま渡さない）", () => {
    // 930/5026 はカタカナ（290）、939/5035/931/1399 は英小文字（1027）
    expect(deviceEnvFor(930)).toEqual({ kbdType: "JKB", codePage: 290, charSet: 1172 });
    expect(deviceEnvFor(5026)).toEqual({ kbdType: "JKB", codePage: 290, charSet: 1172 });
    expect(deviceEnvFor(939)).toEqual({ kbdType: "JPB", codePage: 1027, charSet: 1172 });
    expect(deviceEnvFor(5035)).toEqual({ kbdType: "JEB", codePage: 1027, charSet: 1172 });
    expect(deviceEnvFor(931)).toEqual({ kbdType: "JEB", codePage: 1027, charSet: 1172 });
  });

  // ~~1399 は JEB・1172~~ → ACS と同じ JPE・1027・32000（`20260921-device-env-1399`。ACS のコアに
  // `codePageKey=KEY_JAPAN_ENGLISH_EX_EURO` で当てたワイヤが `KBDTYPE JPE / CODEPAGE 1027 / CHARSET 32000`）
  it("**1399 は ACS と同じ JPE・1027・32000**（GCSGID 65535 を 32000 に置き換える）", () => {
    expect(deviceEnvFor(1399)).toEqual({ kbdType: "JPE", codePage: 1027, charSet: 32000 });
  });

  it("**939 は JPB**（ACS 実機の申告に合わせた。5035 と 931 は JEB。1399 は上の JPE）", () => {
    expect(deviceEnvFor(939)?.kbdType).toBe("JPB");
    expect(deviceEnvFor(5035)?.kbdType).toBe("JEB");
  });

  it("知らない CCSID は申告しない（undefined。勝手に既定へ寄せない）", () => {
    expect(deviceEnvFor(1234)).toBeUndefined();
    expect(deviceEnvFor(1208)).toBeUndefined();
  });

  /**
   * **930/5026 の Katakana / Katakana Extended**（`20260922-katakana-variant-setting`）。
   * ACS 自身が利用者に選ばせる軸なので、既定（未指定）は変えない（AC4）。
   */
  describe("930/5026 の Katakana 変種", () => {
    it("**未指定は現状どおり CHARSET 1172**（Katakana Extended 寄り。既存利用者の挙動を変えない）", () => {
      expect(deviceEnvFor(930)).toEqual({ kbdType: "JKB", codePage: 290, charSet: 1172 });
      expect(deviceEnvFor(5026)).toEqual({ kbdType: "JKB", codePage: 290, charSet: 1172 });
    });

    it("**\"katakana-ex\" も未指定と同じ**（CHARSET 1172）", () => {
      expect(deviceEnvFor(930, "katakana-ex")).toEqual({ kbdType: "JKB", codePage: 290, charSet: 1172 });
    });

    it("**\"katakana\" は CHARSET 332 に差し替える**（KBDTYPE・CODEPAGE は変わらない）", () => {
      expect(deviceEnvFor(930, "katakana")).toEqual({ kbdType: "JKB", codePage: 290, charSet: 332 });
      expect(deviceEnvFor(5026, "katakana")).toEqual({ kbdType: "JKB", codePage: 290, charSet: 332 });
    });

    it("**930/5026 以外は \"katakana\" を渡しても無視する**", () => {
      expect(deviceEnvFor(939, "katakana")).toEqual({ kbdType: "JPB", codePage: 1027, charSet: 1172 });
      expect(deviceEnvFor(1399, "katakana")).toEqual({ kbdType: "JPE", codePage: 1027, charSet: 32000 });
    });

    it("知らない CCSID に \"katakana\" を渡しても undefined のまま", () => {
      expect(deviceEnvFor(1234, "katakana")).toBeUndefined();
    });
  });
});
