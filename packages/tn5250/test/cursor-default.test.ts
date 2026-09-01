import { describe, it, expect } from "vitest";
import { applyDataStream } from "../src/protocol/wtd-applier.js";
import { ScreenBuffer } from "../src/screen/buffer.js";
import { codecForCcsid } from "@ts5250/ebcdic/codec";
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

/**
 * **カーソルが入力できない桁にあるか**（`cursorIsUnenterable`）。
 *
 * 「画面は変わったのにカーソルが 1 桁も動かず、しかもそこが保護欄」という形を見分けるための
 * 材料。`Session5250` はこれと「動いていない」を併せて、最初の入力欄へ寄せる（ACS と同じ）。
 */
describe("カーソルが入力できない桁にあるかを見分ける", () => {
  /** 保護欄（5 行 10 桁・BYPASS）と入力欄（10 行 10 桁）を並べた画面 */
  function protectedThenInput(): Uint8Array {
    return Uint8Array.from([
      ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00,
      ORDER.SBA, 5, 10,
      ORDER.SF, 0x60, 0x00, 0x20, 0x00, 6, // 0x2000=BYPASS（保護）
      ORDER.SBA, 10, 10,
      ORDER.SF, 0x40, 0x00, 0x20, 0x00, 8,
      ESC, COMMAND.READ_MDT_FIELDS, 0x00, 0x00
    ]);
  }

  it("保護欄の中なら true（入力欄が他にあるとき）", () => {
    const buf = new ScreenBuffer();
    applyDataStream(protectedThenInput(), buf, codec);
    buf.cursorAddr = buf.addrOf(5, 12); // 保護欄の中
    expect(buf.cursorIsUnenterable()).toBe(true);
  });

  it("入力欄の中なら false", () => {
    const buf = new ScreenBuffer();
    applyDataStream(protectedThenInput(), buf, codec);
    buf.cursorAddr = buf.addrOf(10, 12);
    expect(buf.cursorIsUnenterable()).toBe(false);
  });

  it("どの欄にも属さない桁なら true", () => {
    const buf = new ScreenBuffer();
    applyDataStream(protectedThenInput(), buf, codec);
    buf.cursorAddr = buf.addrOf(1, 1);
    expect(buf.cursorIsUnenterable()).toBe(true);
  });

  /** **入力欄が 1 つも無い画面では寄せ先が無い**ので false（寄せる判断をさせない） */
  it("入力欄が無ければ false", () => {
    const buf = new ScreenBuffer();
    applyDataStream(
      Uint8Array.from([
        ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00,
        ORDER.SBA, 5, 10,
        ORDER.SF, 0x60, 0x00, 0x20, 0x00, 6,
        ESC, COMMAND.READ_MDT_FIELDS, 0x00, 0x00
      ]),
      buf,
      codec
    );
    buf.cursorAddr = buf.addrOf(5, 12);
    expect(buf.cursorIsUnenterable()).toBe(false);
  });
});
