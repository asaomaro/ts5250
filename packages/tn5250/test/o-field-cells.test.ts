import { describe, it, expect } from "vitest";
import { applyDataStream } from "../src/protocol/wtd-applier.js";
import { buildReadMdtResponse, buildReadMdtAltResponse, encodedFieldLength } from "../src/protocol/read-response.js";
import { parseRecord } from "../src/protocol/gds.js";
import { ScreenBuffer } from "../src/screen/buffer.js";
import { rawSentinel } from "../src/screen/attr-sentinel.js";
import { ESC, COMMAND, ORDER, AID } from "../src/protocol/constants.js";
import { codecForCcsid } from "@ts5250/ebcdic/codec";

/**
 * **O 欄の明示の並び**（`20260928-o-field-cells`）。web-ui は O 欄の編集の値に SO/SI の印（0x0E・0x0F のセンチネル）を持つ。
 * コアはそれを構造どおりのセル（SO・全角の前半/後半・SI・空）に置き、SO/SI を付け直さずに送る——ACS がセルのまま送るのと同じ形
 */
const codec = codecForCcsid(930);
const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const SO = rawSentinel(0x0e);
const SI = rawSentinel(0x0f);

function oField(): ScreenBuffer {
  const buf = new ScreenBuffer();
  applyDataStream(
    Uint8Array.from([ESC, COMMAND.CLEAR_UNIT, ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00, ORDER.SBA, 5, 9, ORDER.SF, 0x40, 0x00, 0x82, 0x80, 0x20, 0x00, 0x0c]),
    buf,
    codec,
    () => {}
  );
  return buf;
}
const send = (buf: ScreenBuffer): string => hex(parseRecord(buildReadMdtResponse(buf, codec, AID.ENTER, { row: 5, col: 10 }).record).data.subarray(6));
const kinds = (buf: ScreenBuffer): string =>
  buf.snapshot("s", false).cells[4]!.slice(9, 21).map((c) => (c.kind === "sbcs" ? (c.char === " " ? "." : c.char) : c.kind === "so" ? "{" : c.kind === "si" ? "}" : c.kind === "dbcs-lead" ? "L" : "t")).join("");

describe("O 欄の明示の並び（コア）", () => {
  it("**別の並び（…SI SO う SI）をそのまま送る**（ACS の挿入の (i) の形）", () => {
    const buf = oField();
    buf.setFieldValue(buf.orderedFields()[0]!, SO + "あ" + SI + SO + "う" + SI + "X", true);
    expect(send(buf)).toBe("0e4481" + "0f" + "0e" + "4483" + "0f" + "e7");
    expect(kinds(buf)).toBe("{Lt}{Lt}X...");
  });

  it("**空の SO/SI を残して送る**（ACS の挿入の (ii) の形）", () => {
    const buf = oField();
    buf.setFieldValue(buf.orderedFields()[0]!, SO + SI + "X" + SO + "あ" + SI, true);
    expect(send(buf)).toBe("0e0f" + "e7" + "0e4481" + "0f");
  });

  it("末尾の半角空白は空のセル（NUL）にし、送るときに落ちる。途中の空白は送る", () => {
    const buf = oField();
    buf.setFieldValue(buf.orderedFields()[0]!, "A B" + SO + SI + "   ", true);
    expect(send(buf)).toBe("c140c2" + "0e0f");
  });

  it("ALT でも同じバイト列（途中の NUL は無い）", () => {
    const buf = oField();
    buf.setFieldValue(buf.orderedFields()[0]!, SO + "あ" + SI, true);
    expect(hex(parseRecord(buildReadMdtAltResponse(buf, codec, AID.ENTER, { row: 5, col: 10 }).record).data.subarray(6))).toBe("0e44810f");
  });

  it("**桁が欄を越えれば FIELD_OVERFLOW**（12 桁の欄に 13 桁）", () => {
    const buf = oField();
    expect(() => buf.setFieldValue(buf.orderedFields()[0]!, SO + "あいうえお" + SI + "X", true)).toThrow(/at most 12/);
  });

  it("**並びの中の半角は 1 セル**（NUL を空白にして返した原本の書き戻しで桁が倍にならない）・組にならない生バイトは捨てない", () => {
    const buf = oField();
    buf.setFieldValue(buf.orderedFields()[0]!, SO + "あ" + " " + "い" + SI, true);
    expect(kinds(buf)).toBe("{Lt.Lt}.....");
    const b2 = oField();
    b2.setFieldValue(b2.orderedFields()[0]!, SO + rawSentinel(0x44) + SI + "X", true);
    expect(send(b2)).toBe("0e440fe7");
  });

  it("**並びの中に半角が混ざっても、途中に SO/SI を足さない**（1 字ずつ書く）", () => {
    const buf = oField();
    buf.setFieldValue(buf.orderedFields()[0]!, SO + "あ" + "X" + "い" + SI, true);
    expect(send(buf)).toBe("0e4481e744820f");
  });

  it("送る長さの見積もり（`encodedFieldLength`）も印を SO/SI の 1 バイトに数え、付け直さない", () => {
    expect(encodedFieldLength(SO + "あ" + SI + SO + "う" + SI, codec, false)).toBe(8);
    expect(encodedFieldLength("あ" + "う", codec, false)).toBe(6); // 印の無い値は従来どおり 1 つの並び
  });
});
