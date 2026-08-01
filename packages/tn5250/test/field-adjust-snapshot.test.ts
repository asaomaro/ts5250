import { describe, it, expect } from "vitest";
import { applyDataStream } from "../src/protocol/wtd-applier.js";
import { ScreenBuffer } from "../src/screen/buffer.js";
import { codecForCcsid } from "@as400web/ebcdic/codec";
import { ESC, COMMAND, ORDER, FFW } from "../src/protocol/constants.js";
import type { Field } from "../src/screen/types.js";

const codec = codecForCcsid(37);

/**
 * FFW の ADJUST（下位 3 ビット）と signed-num をスナップショットへ出せるか。
 *
 * 期待値の根拠は実機の実測（`.aidev/works/20260729-field-adjust-local-edit-keys/research.md`）。
 * DDS の `CHECK(RZ)/(RB)/(MF)` はそれぞれ 0x5 / 0x6 / 0x7 として FFW に載ってきた。
 */
function fieldFor(ffw: number): Field {
  const buf = new ScreenBuffer();
  applyDataStream(
    Uint8Array.from([
      ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00,
      ORDER.SBA, 3, 10,
      ORDER.SF, (ffw >> 8) & 0xff, ffw & 0xff, 0x24, 0x00, 0x06
    ]),
    buf,
    codec,
    () => {}
  );
  return buf.snapshot("t", false).fields[0]!;
}

describe("snapshot — FFW の ADJUST", () => {
  it("CHECK(RZ) 相当（0x0005）は right-zero", () => {
    expect(fieldFor(FFW.ID_VALUE | FFW.ADJUST_RIGHT_ZERO).adjust).toBe("right-zero");
  });

  it("CHECK(RB) 相当（0x0006）は right-blank", () => {
    expect(fieldFor(FFW.ID_VALUE | FFW.ADJUST_RIGHT_BLANK).adjust).toBe("right-blank");
  });

  it("CHECK(MF) 相当（0x0007）は mandatory-fill", () => {
    expect(fieldFor(FFW.ID_VALUE | FFW.ADJUST_MANDATORY_FILL).adjust).toBe("mandatory-fill");
  });

  it("無指定（0x0000）では adjust を付けない", () => {
    expect(fieldFor(FFW.ID_VALUE).adjust).toBeUndefined();
  });

  it("予約値（0x0001–0x0004）は無指定として扱う", () => {
    // tn5250 field.h の MF_RESERVED_1..4。意味が決まっていないものを右寄せに丸めない
    for (const reserved of [0x0001, 0x0002, 0x0003, 0x0004]) {
      expect(fieldFor(FFW.ID_VALUE | reserved).adjust).toBeUndefined();
    }
  });
});

describe("snapshot — signedNumeric", () => {
  it("shift=signed-num（0x0700）で true", () => {
    const f = fieldFor(FFW.ID_VALUE | FFW.SHIFT_SIGNED_NUMERIC);
    expect(f.signedNumeric).toBe(true);
    expect(f.numeric).toBe(true);
  });

  it("numeric-only / digits-only では付かない（numeric は true のまま）", () => {
    for (const shift of [FFW.SHIFT_NUMERIC_ONLY, FFW.SHIFT_DIGITS_ONLY]) {
      const f = fieldFor(FFW.ID_VALUE | shift);
      expect(f.signedNumeric).toBeUndefined();
      expect(f.numeric).toBe(true);
    }
  });

  it("英数字欄では付かない", () => {
    expect(fieldFor(FFW.ID_VALUE).signedNumeric).toBeUndefined();
  });
});
