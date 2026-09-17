import { describe, it, expect } from "vitest";
import { ScreenBuffer } from "../src/screen/buffer.js";
import { applyDataStream } from "../src/protocol/wtd-applier.js";
import { buildSaveScreenResponse } from "../src/protocol/save-screen.js";
import { selfCheckDigitOk } from "../src/screen/field-validate.js";
import { isDbcsOnly } from "../src/browser.js";
import { codecForCcsid } from "@ts5250/ebcdic/codec";
import { COMMAND, ESC, ORDER } from "../src/protocol/constants.js";

/**
 * **FCW の DBCS 種別と自己点検欄を ACS（`Field5250` の定数）と同じに解釈する。**
 *
 * 以前は 3 値で、`0x8200` を "pure" と取り違え、本来の pure（`0x8220`）を取りこぼし、
 * ACS が種別として扱わない `0x82c0` を open に含めていた。自己点検欄
 * （`0xB140` / `0xB1A0`＝DDS の `CHECK(M11)` / `CHECK(M10)`）は読み飛ばしていたので、
 * 検査桁の合わない値がそのままホストへ届いていた（ホストはこれを検証しない）。
 */
const codec = codecForCcsid(37);

/** 行 5 桁 10 に FCW 付きの入力欄（長さ 8）を 1 つ置いた画面 */
function screenWithFcw(...fcws: number[]): ScreenBuffer {
  const buf = new ScreenBuffer();
  applyDataStream(
    Uint8Array.from([
      ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00,
      ORDER.SBA, 5, 10,
      ORDER.SF, 0x40, 0x00,
      ...fcws.flatMap((f) => [f >> 8, f & 0xff]),
      0x20, 0x00, 8
    ]),
    buf,
    codec,
    () => {}
  );
  return buf;
}

describe("FCW の DBCS 種別（ACS `Field5250` と同じ 4 種）", () => {
  it.each([
    ["8200", "only"],
    ["8220", "pure"],
    ["8240", "either"],
    ["8280", "open"]
  ] as const)("FCW 0x%s → %s", (fcw, kind) => {
    const f = screenWithFcw(parseInt(fcw, 16)).snapshot("t", false).fields[0];
    expect(f?.dbcsType).toBe(kind);
  });

  it("上記以外（0x82c0 など）は ACS と同じく種別として扱わない", () => {
    expect(screenWithFcw(0x82c0).snapshot("t", false).fields[0]?.dbcsType).toBeUndefined();
  });

  it("SAVE SCREEN の応答で同じ FCW を書き戻す（往復で種別が変わらない）", () => {
    for (const fcw of [0x8200, 0x8220, 0x8240, 0x8280]) {
      const buf = screenWithFcw(fcw);
      const rec = buildSaveScreenResponse(buf, codec);
      const back = new ScreenBuffer();
      // GDS ヘッダ（10 バイト）と先頭の ESC RESTORE_SCREEN を外して適用し直す
      applyDataStream(rec.slice(12), back, codec, () => {});
      expect(back.snapshot("t", false).fields[0]?.dbcsType).toBe(buf.snapshot("t", false).fields[0]?.dbcsType);
    }
  });

  it("全角専用なのは only（J 型）と pure だけ", () => {
    expect(isDbcsOnly("only")).toBe(true);
    expect(isDbcsOnly("pure")).toBe(true);
    expect(isDbcsOnly("either")).toBe(false);
    expect(isDbcsOnly("open")).toBe(false);
    expect(isDbcsOnly(undefined)).toBe(false);
  });
});

describe("自己点検欄の FCW（CHECK(M11)=0xB140 / CHECK(M10)=0xB1A0）", () => {
  it("0xB140 は mod11、0xB1A0 は mod10 として snapshot に載る", () => {
    expect(screenWithFcw(0xb140).snapshot("t", false).fields[0]?.selfCheck).toBe("mod11");
    expect(screenWithFcw(0xb1a0).snapshot("t", false).fields[0]?.selfCheck).toBe("mod10");
  });

  it("指定の無い欄には付けない", () => {
    expect(screenWithFcw().snapshot("t", false).fields[0]).not.toHaveProperty("selfCheck");
  });

  it("DBCS 種別など他の FCW と併記されても両方拾う", () => {
    const f = screenWithFcw(0x8280, 0xb1a0).snapshot("t", false).fields[0];
    expect(f?.dbcsType).toBe("open");
    expect(f?.selfCheck).toBe("mod10");
  });
});

describe("selfCheckDigitOk（ACS `Field5250.checkModulusField` の検算）", () => {
  it("mod10: 右端から 1,2 の交互重み。2 倍が 10 以上なら 9 を引く", () => {
    // 1230: 本体 123 → 3×2 + 2×1 + 1×2 = 10 → 余り 0 → 検査桁 0 で合格
    expect(selfCheckDigitOk("1230", "mod10")).toBe(true);
    expect(selfCheckDigitOk("1234", "mod10")).toBe(false);
    // Luhn の代表例（9×2=18→9 の引き算を通る）
    expect(selfCheckDigitOk("79927398713", "mod10")).toBe(true);
    expect(selfCheckDigitOk("79927398710", "mod10")).toBe(false);
  });

  it("mod11: 右端から 2,3,4,5,6,7 の繰り返し重み", () => {
    // 1236: 本体 123 → 3×2 + 2×3 + 1×4 = 16 → 余り 5 → 5 + 6 = 11 で合格
    expect(selfCheckDigitOk("1236", "mod11")).toBe(true);
    expect(selfCheckDigitOk("1235", "mod11")).toBe(false);
    // 余り 0 は検査桁 0 のときだけ合格（31: 1×2 + 3×3 = 11）
    expect(selfCheckDigitOk("310", "mod11")).toBe(true);
    expect(selfCheckDigitOk("311", "mod11")).toBe(false);
    // 7 の次は 2 へ戻る（本体 7 桁: 1×2+1×3+…+1×7 + 1×2 = 29 → 余り 7 → 検査桁 4。
    // 戻らずに 8 を掛けると 35 → 余り 2 → 検査桁 9 になって区別できる）
    expect(selfCheckDigitOk("11111114", "mod11")).toBe(true);
    expect(selfCheckDigitOk("11111119", "mod11")).toBe(false);
  });

  it("全桁 0・空欄・1 桁以下は検査しない（ACS と同じ素通し）", () => {
    expect(selfCheckDigitOk("0000", "mod10")).toBe(true);
    expect(selfCheckDigitOk("0000", "mod11")).toBe(true);
    expect(selfCheckDigitOk("", "mod11")).toBe(true);
    expect(selfCheckDigitOk("    ", "mod10")).toBe(true);
    expect(selfCheckDigitOk("7", "mod10")).toBe(true);
  });

  it("前後の空白は落として検算する", () => {
    expect(selfCheckDigitOk(" 1230 ", "mod10")).toBe(true);
    expect(selfCheckDigitOk(" 1234 ", "mod10")).toBe(false);
  });
});
