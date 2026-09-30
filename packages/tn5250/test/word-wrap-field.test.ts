import { describe, it, expect } from "vitest";
import { applyDataStream } from "../src/protocol/wtd-applier.js";
import { buildReadMdtResponse, buildReadMdtAltResponse } from "../src/protocol/read-response.js";
import { parseRecord } from "../src/protocol/gds.js";
import { ScreenBuffer } from "../src/screen/buffer.js";
import { rawSentinel } from "../src/screen/attr-sentinel.js";
import { ESC, COMMAND, ORDER, AID } from "../src/protocol/constants.js";
import { codecForCcsid } from "@ts5250/ebcdic/codec";

/**
 * **語送りの欄（FCW 0x8680。DDS の `WRDWRAP`）の値**（`20260930-word-wrap`）。画面は実機の DSM の WRAPFLD と同じ:
 * (5,70) から 30 桁（5 行目の 11 桁＋6 行目の頭から 19 桁）。実機の ACS のコア（`scripts/acs-probe/word-wrap.txt`）でホストが受け取ったバイト列と比べる:
 * 語送りは行の残りを **NUL で埋めて**語を次の行へ送る（`aaa bbbb ` + NUL 2 つ ｜ `cccc dddd`）。READ MDT では途中の NUL が 0x40、ALT では 00 のまま
 */
const codec = codecForCcsid(37);
const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const NUL = rawSentinel(0x00);

function screen(sbaCol = 69, length = 30): ScreenBuffer {
  const buf = new ScreenBuffer();
  applyDataStream(
    Uint8Array.from([
      ESC, COMMAND.CLEAR_UNIT, ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00,
      ORDER.SBA, 5, sbaCol, ORDER.SF, 0x40, 0x00, 0x86, 0x80, 0x20, 0x00, length
    ]),
    buf,
    codec,
    () => {}
  );
  return buf;
}
const dataOf = (rec: Uint8Array): string => hex(parseRecord(rec).data.subarray(6));
const sendMdt = (buf: ScreenBuffer): string => dataOf(buildReadMdtResponse(buf, codec, AID.ENTER, { row: 5, col: 70 }).record);
const sendAlt = (buf: ScreenBuffer): string => dataOf(buildReadMdtAltResponse(buf, codec, AID.ENTER, { row: 5, col: 70 }).record);

/** 実機の W1（`aaa bbbb cccc dddd` を打った後）の欄 */
const W1 = "aaa bbbb " + NUL + NUL + "cccc dddd";

describe("語送りの欄の印（FCW 0x8680）", () => {
  it("2 行にまたがる単独の欄は wordWrap が立つ", () => {
    expect(screen().snapshot("t", false).fields[0]?.wordWrap).toBe(true);
  });
  it("1 行に収まる欄は立たない（ACS は WrapField を下ろす）", () => {
    // (5,10) から 20 桁: 行の中
    expect(screen(9, 20).snapshot("t", false).fields[0]?.wordWrap).toBeUndefined();
  });
});

describe("語送りの欄の値と送信（実機の ACS のコアの W1〜W8）", () => {
  it("W1: 途中の NUL は READ MDT で 40（W7）、ALT で 00（W1）。末尾の NUL は送らない", () => {
    const buf = screen();
    buf.setFieldValue(buf.orderedFields()[0]!, W1);
    // W7（READ MDT）: 81 81 81 40 82×4 40 [40 40] 83×4 40 84×4
    expect(sendMdt(buf)).toBe("818181408282828240" + "4040" + "8383838340" + "84848484");
    // W1（ALT）: 途中の NUL が 00 のまま
    expect(sendAlt(buf)).toBe("818181408282828240" + "0000" + "8383838340" + "84848484");
  });
  it("値は途中の NUL をセンチネルで返す（実空白と区別して持ち回る）。末尾の NUL・空白は落とす", () => {
    const buf = screen();
    const f = buf.orderedFields()[0]!;
    buf.setFieldValue(f, W1);
    expect(buf.fieldValue(f)).toBe(W1);
    expect(buf.snapshot("t", false).fields[0]?.value).toBe(W1);
  });
  it("打った末尾の空白は送る（ACS は末尾の NUL だけ落とす）", () => {
    const buf = screen();
    buf.setFieldValue(buf.orderedFields()[0]!, "ab ");
    expect(sendAlt(buf)).toBe("818240");
  });
  it("語送りでない欄は従来どおり（途中の NUL のセンチネルは値に出ない）", () => {
    const buf = new ScreenBuffer();
    applyDataStream(
      Uint8Array.from([ESC, COMMAND.CLEAR_UNIT, ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00, ORDER.SBA, 5, 9, ORDER.SF, 0x40, 0x00, 0x20, 0x00, 0x10, 0xc1, 0x00, 0xc2]),
      buf,
      codec,
      () => {}
    );
    const f = buf.orderedFields()[0]!;
    expect(f.wordWrap).toBeUndefined();
    expect(buf.fieldValue(f)).toBe("A B");
  });
});
