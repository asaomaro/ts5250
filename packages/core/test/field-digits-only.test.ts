import { describe, it, expect } from "vitest";
import { applyDataStream } from "../src/protocol/wtd-applier.js";
import { ScreenBuffer } from "../src/screen/buffer.js";
import { codecForCcsid } from "../src/codec/codec.js";
import { ESC, COMMAND, ORDER, FFW } from "../src/protocol/constants.js";

const codec = codecForCcsid(37);

/**
 * **`digitsOnly` は数値 3 種のうち digits-only だけを見分ける印。**
 *
 * `field-validate.ts` の許容集合は digits-only が `/^[0-9]*$/`、
 * numeric-only / signed-numeric が `/^[0-9.,+-]*$/`。既存の `numeric` は 3 種をまとめて
 * true にするので、「本当に数字しか通らない欄」を区別できなかった。
 * web-ui がモバイルの `inputmode="numeric"` を**塞がずに**付けるために要る。
 */
describe("Field.digitsOnly", () => {
  /** 行 5 桁 10 に shift 指定つきの入力欄を 1 つ置く WTD */
  function fieldWithShift(shift: number): Uint8Array {
    const ffw = 0x4000 | shift; // 0x4000 は「フィールドである」ことを示す識別ビット
    return Uint8Array.from([
      ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00,
      ORDER.SBA, 5, 10,
      ORDER.SF, (ffw >> 8) & 0xff, ffw & 0xff, 0x20, 0x00, 8
    ]);
  }
  const fieldOf = (shift: number) => {
    const buf = new ScreenBuffer();
    applyDataStream(fieldWithShift(shift), buf, codec);
    return buf.snapshot("s", false).fields[0]!;
  };

  it("digits-only では digitsOnly が立つ", () => {
    const f = fieldOf(FFW.SHIFT_DIGITS_ONLY);
    expect(f.digitsOnly).toBe(true);
    expect(f.numeric).toBe(true);
  });

  it("numeric-only では立たない（`.` `,` `+` `-` を許容するため）", () => {
    const f = fieldOf(FFW.SHIFT_NUMERIC_ONLY);
    expect(f.digitsOnly).toBeUndefined();
    expect(f.numeric).toBe(true);
  });

  it("signed-numeric でも立たない", () => {
    const f = fieldOf(FFW.SHIFT_SIGNED_NUMERIC);
    expect(f.digitsOnly).toBeUndefined();
    expect(f.signedNumeric).toBe(true);
  });

  it("英数字欄では立たない", () => {
    const f = fieldOf(0x0000);
    expect(f.digitsOnly).toBeUndefined();
    expect(f.numeric).toBe(false);
  });
});
