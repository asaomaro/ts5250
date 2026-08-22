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
    expect(deviceEnvFor(1399)).toEqual({ kbdType: "JEB", codePage: 1027, charSet: 1172 });
  });

  it("**939 だけ JPB**（ACS 実機の申告に合わせた。他の英小文字系は JEB）", () => {
    expect(deviceEnvFor(939)?.kbdType).toBe("JPB");
    expect(deviceEnvFor(5035)?.kbdType).toBe("JEB");
  });

  it("知らない CCSID は申告しない（undefined。勝手に既定へ寄せない）", () => {
    expect(deviceEnvFor(1234)).toBeUndefined();
    expect(deviceEnvFor(1208)).toBeUndefined();
  });
});
