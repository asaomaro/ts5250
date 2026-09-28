import { describe, it, expect } from "vitest";
import { applyDataStream } from "../src/protocol/wtd-applier.js";
import { buildReadMdtResponse } from "../src/protocol/read-response.js";
import { parseRecord } from "../src/protocol/gds.js";
import { ScreenBuffer } from "../src/screen/buffer.js";
import { rawSentinel } from "../src/screen/attr-sentinel.js";
import { ESC, COMMAND, ORDER, AID } from "../src/protocol/constants.js";
import { codecForCcsid } from "@ts5250/ebcdic/codec";

/**
 * **J・全角の E の欄の送信**（`20260928-je-field-shape`）。web-ui が渡す印入りの値（SO・字・NUL の組・SI）から
 * コアが組む READ MDT の欄データを、実機の ACS のコアでホストが受け取ったバイト列（DSM の JEEDIT。
 * `scripts/acs-probe/je-field-edit.txt`）と比べる。欄は (3,10) の 12 桁
 */
const codec = codecForCcsid(930);
const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const SO = rawSentinel(0x0e);
const SI = rawSentinel(0x0f);
const DEAD = rawSentinel(0x00);

function screen(fcw: number): ScreenBuffer {
  const buf = new ScreenBuffer();
  applyDataStream(
    Uint8Array.from([ESC, COMMAND.CLEAR_UNIT, ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00, ORDER.SBA, 3, 9, ORDER.SF, 0x40, 0x00, fcw >> 8, fcw & 0xff, 0x24, 0x00, 0x0c]),
    buf,
    codec,
    () => {}
  );
  return buf;
}
const send = (buf: ScreenBuffer, v: string): string => {
  buf.setFieldValue(buf.orderedFields()[0]!, v, true);
  return hex(parseRecord(buildReadMdtResponse(buf, codec, AID.ENTER, { row: 3, col: 10 }).record).data.subarray(6));
};

describe("J・全角の E の欄の送信（ACS の JEEDIT の測定）", () => {
  it("J の欄（full）: SO と SI の間の空きの NUL の組は空白の組で送る（ACS J1 の 1 欄目）", () => {
    expect(send(screen(0x8200), SO + "あい" + DEAD.repeat(6) + SI)).toBe("0e448144824040404040400f");
  });
  it("J の欄（full）: 1 字だけでも SI は欄の最後の桁（ACS J1 の 4 欄目）", () => {
    expect(send(screen(0x8200), SO + "あ" + DEAD.repeat(8) + SI)).toBe("0e448140404040404040400f");
  });
  it("E の欄（compact）: SI は中身の直後（ACS J2 の 5 欄目）", () => {
    expect(send(screen(0x8240), SO + "いあ" + SI)).toBe("0e448244810f");
  });
  it("E の欄（open）: SI の無い並びは SI を足さずに送る（ACS J3 の 4 欄目）", () => {
    expect(send(screen(0x8240), SO + "い")).toBe("0e4482");
  });
});
