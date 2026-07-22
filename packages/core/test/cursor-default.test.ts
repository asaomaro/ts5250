import { describe, it, expect } from "vitest";
import { applyDataStream } from "../src/protocol/wtd-applier.js";
import { ScreenBuffer } from "../src/screen/buffer.js";
import { codecForCcsid } from "../src/codec/codec.js";
import { ESC, COMMAND, ORDER } from "../src/protocol/constants.js";

const codec = codecForCcsid(37);

/** 行 5 桁 10 に長さ 8 の入力フィールドを 1 つ置く WTD（IC は付けない） */
function screenWithOneField(withIc: boolean): Uint8Array {
  return Uint8Array.from([
    ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00,
    ORDER.SBA, 5, 10,
    ORDER.SF, 0x40, 0x00, 0x20, 0x00, 8,
    ...(withIc ? [ORDER.IC, 12, 40] : []),
    ESC, COMMAND.READ_MDT_FIELDS, 0x00, 0x00
  ]);
}

describe("IC の無い WTD ではカーソルを最初の入力フィールドへ", () => {
  it("IC が無ければ cursorSet は false", () => {
    const buf = new ScreenBuffer();
    const result = applyDataStream(screenWithOneField(false), buf, codec);
    expect(result.readRequested).toBe(true);
    expect(result.cursorSet).toBe(false);
  });

  it("IC があれば cursorSet が true でカーソルはその位置", () => {
    const buf = new ScreenBuffer();
    const result = applyDataStream(screenWithOneField(true), buf, codec);
    expect(result.cursorSet).toBe(true);
    expect(buf.rowColOf(buf.cursorAddr)).toEqual({ row: 12, col: 40 });
  });

  it("cursorToFirstInputField は属性桁の次（フィールド先頭）へ置く", () => {
    const buf = new ScreenBuffer();
    applyDataStream(screenWithOneField(false), buf, codec);
    expect(buf.rowColOf(buf.cursorAddr)).toEqual({ row: 1, col: 1 });
    buf.cursorToFirstInputField();
    expect(buf.rowColOf(buf.cursorAddr)).toEqual({ row: 5, col: 11 });
  });
});
