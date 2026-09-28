import { describe, it, expect } from "vitest";
import { applyDataStream } from "../src/protocol/wtd-applier.js";
import { buildReadMdtResponse, buildReadMdtAltResponse } from "../src/protocol/read-response.js";
import { parseRecord } from "../src/protocol/gds.js";
import { ScreenBuffer } from "../src/screen/buffer.js";
import { rawSentinel } from "../src/screen/attr-sentinel.js";
import { ESC, COMMAND, ORDER, AID } from "../src/protocol/constants.js";
import { codecForCcsid } from "@ts5250/ebcdic/codec";

/**
 * **継続した O 欄の送信**（`20260928-cont-o-cells`）。画面は DSM の CONTOX と同じ（(5,10)・(6,10)・(7,10) に O の継続欄 8 桁ずつ。
 * 先頭 `SO い え SI X NUL`・中間 `Y Z NUL…`・最終 空）。web-ui が鎖の編集の後に区間ごとに渡す値（SO/SI・死んだ桁の印入り）から、
 * コアが組む READ MDT の欄データを、実機の ACS のコアでホストが受け取ったバイト列（`scripts/acs-probe/cont-o-edit.txt`・research F2）と比べる
 */
const codec = codecForCcsid(930);
const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const SO = rawSentinel(0x0e);
const SI = rawSentinel(0x0f);
const DEAD = rawSentinel(0x00);

function chain(): ScreenBuffer {
  const buf = new ScreenBuffer();
  const seg = (row: number, code: number, data: number[]): number[] => [ORDER.SBA, row, 9, ORDER.SF, 0x40, 0x00, 0x82, 0x80, 0x86, code, 0x24, 0x00, 0x08, ...data];
  applyDataStream(
    Uint8Array.from([
      ESC, COMMAND.CLEAR_UNIT, ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00,
      ...seg(5, 0x01, [0x0e, 0x44, 0x82, 0x44, 0x84, 0x0f, 0xe7, 0x00]),
      ...seg(6, 0x03, [0xe8, 0xe9, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
      ...seg(7, 0x02, [])
    ]),
    buf,
    codec,
    () => {}
  );
  return buf;
}
/** 欄データだけ（カーソル・AID・SBA の 6 バイトを除く） */
const send = (buf: ScreenBuffer): string => hex(parseRecord(buildReadMdtResponse(buf, codec, AID.ENTER, { row: 5, col: 10 }).record).data.subarray(6));
function edit(buf: ScreenBuffer, ...values: (string | undefined)[]): ScreenBuffer {
  const segs = buf.orderedFields();
  values.forEach((v, i) => {
    if (v !== undefined) buf.setFieldValue(segs[i]!, v, true);
  });
  return buf;
}

describe("継続した O 欄の送信（ACS の CONTOX の測定）", () => {
  it("書かれたままの鎖（MDT だけ立てる）は区間を連結し、途中の NUL を空白に", () => {
    const buf = chain();
    buf.orderedFields()[0]!.mdt = true;
    expect(send(buf)).toBe("0e448244840fe740e8e9");
  });
  it("C01: 先頭 `SO い え う SI`・中間 `X 空 Y Z`（構造の無い区間も桁ごとに）", () => {
    expect(send(edit(chain(), SO + "いえう" + SI, "X YZ"))).toBe("0e4482448444830fe740e8e9");
  });
  it("C02: 死んだ桁は NUL（途中なので空白）で送る", () => {
    expect(send(edit(chain(), SO + "いえ" + SI + DEAD + DEAD, SO + "え" + SI + "X YZ"))).toBe("0e448244840f40400e44840fe740e8e9");
  });
  it("C03: 書かれたままの先頭の区間と編集した中間の区間", () => {
    expect(send(edit(chain(), undefined, SO + "お" + SI + "YZ"))).toBe("0e448244840fe7400e44850fe8e9");
  });
  it("C04: 空の SO SI・割れた並び・SI＋死んだ桁", () => {
    expect(send(edit(chain(), SO + SI + "Q" + SO + "い" + SI + DEAD, SO + "え" + SI + "X YZ"))).toBe("0e0fd80e44820f400e44840fe740e8e9");
  });
  it("C05: 上書きの区間送り（X の後ろが死んだ桁）", () => {
    expect(send(edit(chain(), SO + "いえ" + SI + "X" + DEAD, SO + "か" + SI))).toBe("0e448244840fe7400e44860f");
  });
  it("C12: **前の区間の最後の桁が SI で次の区間の頭が SO なら、両方を落として並びを繋ぐ**（ACS `FFT5250.getFieldContents`）", () => {
    expect(send(edit(chain(), SO + "いきく" + SI, SO + "え" + SI + "X YZ"))).toBe("0e44824487448844840fe740e8e9");
  });
  it("SI の後ろに死んだ桁があれば詰めない（前の区間の最後の桁が NUL）", () => {
    expect(send(edit(chain(), SO + "いえ" + SI + DEAD + DEAD, SO + "え" + SI))).toBe("0e448244840f40400e44840f");
  });
  it("最終区間へ詰めたときも中身は同じ（ACS は長さを保ち末尾に NUL を 2 つ残す——末尾の NUL は送らない）", () => {
    expect(send(edit(chain(), undefined, SO + "いえう" + SI, SO + "か" + SI))).toBe("0e448244840fe740" + "0e448244844483" + "4486" + "0f");
  });
  it("ALT（READ MDT ALT）では途中の死んだ桁を NUL のまま送る", () => {
    const buf = edit(chain(), SO + "いえ" + SI + DEAD + DEAD, SO + "え" + SI + "X YZ");
    // X と Y の間は ACS では NUL（`00`）。当 PJ の O 欄の値は空きと空白を区別しない（半角空白で持つ）ので `40`——既知の差（台帳）
    expect(hex(parseRecord(buildReadMdtAltResponse(buf, codec, AID.ENTER, { row: 5, col: 10 }).record).data.subarray(6))).toBe("0e448244840f00000e44840fe740e8e9");
  });
  it("ALT で途中の死んだ桁は NUL（半角の間でも）", () => {
    const buf = edit(chain(), undefined, "A" + DEAD + "B");
    expect(hex(parseRecord(buildReadMdtAltResponse(buf, codec, AID.ENTER, { row: 5, col: 10 }).record).data.subarray(6))).toBe("0e448244840fe700c100c2");
  });
  it("半角だけの区間の死んだ桁も NUL のセル（明示の並びとして置く）", () => {
    const buf = edit(chain(), undefined, "AB" + DEAD + DEAD);
    const cells = buf.snapshot("s", false).cells[5]!.slice(9, 13);
    expect(cells.map((c) => c.kind === "sbcs" ? c.char : c.kind)).toEqual(["A", "B", " ", " "]);
    expect(send(buf)).toBe("0e448244840fe740c1c2");
  });
});
