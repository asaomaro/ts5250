import { describe, it, expect } from "vitest";
import { applyDataStream } from "../src/protocol/wtd-applier.js";
import {
  buildReadMdtResponse,
  buildReadMdtAltResponse,
  buildReadMdtImmediateAltResponse,
  buildReadInputFieldsResponse
} from "../src/protocol/read-response.js";
import { parseRecord } from "../src/protocol/gds.js";
import { ScreenBuffer } from "../src/screen/buffer.js";
import { ESC, COMMAND, ORDER, AID } from "../src/protocol/constants.js";
import { codecForCcsid } from "@ts5250/ebcdic/codec";

/**
 * **再順序付け（SOH の本体 3 バイト目＋FCW 0x80nn）**（`20260928-resequence`）。ACS `FFT5250.firstModifiedField` / `nextModifiedField`・`firstInputField` / `nextInputField`。
 * 期待値の MDT 系は実機の ACS のコア（DSM の RESEQ。`scripts/acs-probe/resequence.txt`）: 鎖 #2(7,10) → #1(5,10) → #3(9,10) で、
 * 3 欄に打つと `11070ac2 11050ac1 11090ac3`、#2・#3 だけ打つと `11070ac2`
 */
const codec = codecForCcsid(930);
const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const data = (record: Uint8Array): string => hex(parseRecord(record).data.subarray(3));

const soh = (first: number): number[] => [ORDER.SOH, 0x07, 0x00, 0x00, first, 0x00, 0x00, 0x00, 0x00];
const sf = (row: number, fcw: number[]): number[] => [ORDER.SBA, row, 9, ORDER.SF, 0x40, 0x00, ...fcw, 0x20, 0x00, 0x06];

/** DSM の RESEQ と同じ画面（`nexts` は #1・#2・#3 の FCW 0x80nn の nn） */
function screen(first = 2, nexts: (number | undefined)[] = [0x03, 0x01, 0xff]): ScreenBuffer {
  const buf = new ScreenBuffer();
  const fcw = (n: number | undefined): number[] => (n === undefined ? [] : [0x80, n]);
  applyDataStream(
    Uint8Array.from([
      ESC, COMMAND.CLEAR_UNIT, ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00,
      ...soh(first), ...sf(5, fcw(nexts[0])), ...sf(7, fcw(nexts[1])), ...sf(9, fcw(nexts[2]))
    ]),
    buf,
    codec,
    () => {}
  );
  return buf;
}
const type = (buf: ScreenBuffer, values: (string | undefined)[]): ScreenBuffer => {
  buf.orderedFields().forEach((f, i) => values[i] !== undefined && buf.setFieldValue(f, values[i]!));
  return buf;
};
const mdt = (buf: ScreenBuffer): string => data(buildReadMdtResponse(buf, codec, AID.ENTER, { row: 5, col: 10 }).record);
const inp = (buf: ScreenBuffer): string => data(buildReadInputFieldsResponse(buf, codec, AID.ENTER, { row: 5, col: 10 }).record);

describe("再順序付け: READ MDT 系（実機の ACS のコアで測った 2 件）", () => {
  it("**3 欄とも打つと鎖の順**（#2 → #1 → #3）。0x82・0x83 も同じ並び", () => {
    expect(mdt(type(screen(), ["A", "B", "C"]))).toBe("11070ac2" + "11050ac1" + "11090ac3");
    expect(data(buildReadMdtAltResponse(type(screen(), ["A", "B", "C"]), codec, AID.ENTER, { row: 5, col: 10 }).record)).toBe("11070ac2" + "11050ac1" + "11090ac3");
    expect(data(buildReadMdtImmediateAltResponse(type(screen(), ["A", "B", "C"]), codec).record)).toBe("11070ac2" + "11050ac1" + "11090ac3");
  });

  it("**辿った先が MDT でなければそこで止まる**（#2・#3 に打っても #1 で止まり #2 だけ）", () => {
    expect(mdt(type(screen(), [undefined, "B", "C"]))).toBe("11070ac2");
  });
});

describe("再順序付け: READ MDT 系（原典の読み・当 PJ の判断）", () => {
  it("最初の欄に MDT が無ければ次へ進む（#1・#3 に打つと #1 → #3。原典 `firstModifiedField`）", () => {
    expect(mdt(type(screen(), ["A", undefined, "C"]))).toBe("11050ac1" + "11090ac3");
  });

  it("番号 0 は終わり・一巡は終わり（**当 PJ の判断**。ACS は例外で応答を作れない。decisions D2）", () => {
    expect(mdt(type(screen(2, [0x03, 0x00, 0xff]), ["A", "B", "C"]))).toBe("11070ac2");
    expect(mdt(type(screen(2, [0x02, 0x01, 0xff]), ["A", "B", "C"]))).toBe("11070ac2" + "11050ac1");
  });
});

describe("再順序付け: READ INPUT 系（原典）", () => {
  it("**MDT を問わず鎖を辿る**（#2 → #1 → #3。空の欄は 0x40 で詰める）", () => {
    // #1 だけに打つと、先頭の #2（空）→ #1 → #3（空）の順で欄長ぶん
    expect(inp(type(screen(), ["A", undefined, undefined]))).toBe("404040404040" + "c14040404040" + "404040404040");
  });

  it("番号 0 は表の次の欄", () => {
    expect(inp(type(screen(1, [0x00, 0x00, 0xff]), ["A", "B", "C"]))).toBe("c14040404040" + "c24040404040" + "c34040404040");
  });
});

describe("再順序付けの寿命・カーソル送りの断り", () => {
  it("**再順序付けの無い画面は画面順のまま**（SOH の本体が 3 バイト未満・番号 0）", () => {
    expect(mdt(type(screen(0), ["A", "B", "C"]))).toBe("11050ac1" + "11070ac2" + "11090ac3");
  });

  it("**SOH の本体が 3 バイト未満なら再順序付けなし**（ACS の SOH 分岐は長さ 3 以上で採る）", () => {
    const buf = new ScreenBuffer();
    applyDataStream(Uint8Array.from([ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00, ORDER.SOH, 0x02, 0x00, 0x00]), buf, codec, () => {});
    expect(buf.resequenceFirst).toBe(0);
    applyDataStream(Uint8Array.from([ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00, ORDER.SOH, 0x03, 0x00, 0x00, 0x02]), buf, codec, () => {});
    expect(buf.resequenceFirst).toBe(2);
  });

  it.each([
    ["CLEAR UNIT", [ESC, COMMAND.CLEAR_UNIT]],
    ["CLEAR UNIT ALTERNATE", [ESC, COMMAND.CLEAR_UNIT_ALTERNATE, 0x00]],
    ["CLEAR FORMAT TABLE", [ESC, COMMAND.CLEAR_FORMAT_TABLE]]
  ])("%s で再順序付けを 0 に戻す（ACS `processClearFMT`）", (_n, cmd) => {
    const buf = screen();
    expect(buf.resequenceFirst).toBe(2);
    applyDataStream(Uint8Array.from(cmd), buf, codec, () => {});
    expect(buf.resequenceFirst).toBe(0);
  });

  it("**退避と復元で再順序付けも戻る**（CLEAR UNIT で 0 にした後、復元すると 2）", () => {
    const buf = screen();
    buf.saveScreen();
    buf.clearUnit();
    expect(buf.resequenceFirst).toBe(0);
    buf.restoreScreen();
    expect(buf.resequenceFirst).toBe(2);
  });

  it("**再順序付けのある画面のカーソル送りの欄は入れず否定応答 0x10050125**（ACS `isValidCursorProgressField`）", () => {
    const buf = new ScreenBuffer();
    const r = applyDataStream(
      Uint8Array.from([ESC, COMMAND.CLEAR_UNIT, ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00, ...soh(1), ...sf(5, [0x88, 0x01])]),
      buf,
      codec,
      () => {}
    );
    expect(r.senseCode).toBe(0x10050125);
    expect(buf.orderedFields()).toHaveLength(0);
  });
});
