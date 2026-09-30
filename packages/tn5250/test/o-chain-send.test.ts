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
  it("死んだ桁は AID のあとも画面に残り（snapshot の `dead`）、バイトとしては NUL で、ホストの書き直しで消える（実機 `cont-o-dead-kept.txt`）", () => {
    const buf = edit(chain(), SO + "いえ" + SI + DEAD + DEAD, SO + "え" + SI + "X YZ");
    const row5 = buf.snapshot("s", false).cells[4]!;
    expect(row5.slice(9, 17).map((c) => c.dead === true)).toEqual([false, false, false, false, false, false, true, true]);
    expect(buf.cellAt(buf.orderedFields()[0]!.startAddr + 6)).toBeNull();
    // ホストが同じ桁へ書けば（新しいセルになるので）死んだ印は消える
    applyDataStream(Uint8Array.from([ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00, ORDER.SBA, 5, 16, 0xc1]), buf, codec, () => {});
    expect(buf.snapshot("s", false).cells[4]![15]!.dead).toBeUndefined();
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
  it("ALT（READ MDT ALT）では途中の死んだ桁も空き（U+0000）も NUL のまま送る（READ MDT では空きは 0x40）", () => {
    const buf = edit(chain(), SO + "いえ" + SI + DEAD + DEAD, SO + "え" + SI + "X\u0000YZ");
    expect(hex(parseRecord(buildReadMdtAltResponse(buf, codec, AID.ENTER, { row: 5, col: 10 }).record).data.subarray(6))).toBe("0e448244840f00000e44840fe700e8e9");
    expect(send(buf)).toBe("0e448244840f40400e44840fe740e8e9");
  });
  it("**鎖の空白（U+0020）は中身**: 途中も末尾も ALT・READ MDT とも 0x40 で送る（空き U+0000 と別。ACS の C09・C10 の末尾の `40`。`20260930-cont-o-nul`）", () => {
    const buf = edit(chain(), undefined, "A B" + " ".repeat(5), "  " + "\u0000".repeat(6));
    // 先頭の区間は書かれたまま（`0e いえ 0f X` と途中の空き）。あとは打った空白が末尾の `40` まで
    const head = "0e448244840fe740";
    expect(send(buf)).toBe(head + "c140c2" + "4040404040" + "4040");
    const alt = hex(parseRecord(buildReadMdtAltResponse(buf, codec, AID.ENTER, { row: 5, col: 10 }).record).data.subarray(6));
    expect(alt).toBe("0e448244840fe700" + "c140c2" + "4040404040" + "4040");
  });
  it("**共有の値の置き方**: 明示の並び（SO/SI 入り）の鎖の末尾の空白は落とさず、空白のセルは生バイト 0x40・空きは空のセル（web-ui が見分ける手掛かり）", () => {
    const buf = edit(chain(), SO + "い" + SI + "A B ", "\u0000");
    expect(send(buf)).toBe("0e44820fc140c240"); // 末尾の空白（0x40）まで送る
    const cells = buf.snapshot("s", false).cells[4]!;
    expect(cells[13]!.char).toBe("A");
    expect(cells[14]!.rawByte).toBe(0x40); // 途中の空白（中身）
    expect(cells[16]!.rawByte).toBe(0x40); // 末尾の空白も落とさず中身のまま
    // 中間の区間の空き（U+0000）は生バイトを持たない空のセル
    expect(buf.snapshot("s", false).cells[5]![9]!.rawByte).toBeUndefined();
  });
  it("印の無い値（半角だけ。generic の経路）でも、鎖の空白は生バイト 0x40・空きは空のセル", () => {
    const buf = edit(chain(), undefined, "A B\u0000C");
    const cells = buf.snapshot("s", false).cells[5]!;
    expect(cells[10]!.rawByte).toBe(0x40); // 空白（中身）
    expect(cells[12]!.rawByte).toBeUndefined(); // 空き（U+0000）
    expect(send(buf)).toBe("0e448244840fe740c140c240c3"); // 途中の空きは READ MDT では 0x40
  });
  it("末尾の空き（U+0000）は送らない", () => {
    const buf = edit(chain(), undefined, "AB" + "\u0000\u0000\u0000\u0000");
    expect(send(buf)).toBe("0e448244840fe740c1c2");
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
