import { describe, it, expect } from "vitest";
import { applyDataStream } from "../src/protocol/wtd-applier.js";
import { buildReadMdtResponse, buildReadMdtAltResponse } from "../src/protocol/read-response.js";
import { parseRecord } from "../src/protocol/gds.js";
import { ScreenBuffer } from "../src/screen/buffer.js";
import { rawSentinel } from "../src/screen/attr-sentinel.js";
import { ESC, COMMAND, ORDER, AID } from "../src/protocol/constants.js";
import { codecForCcsid } from "@ts5250/ebcdic/codec";

/**
 * **継続でない O 欄の送信**（`20260930-nul-typed-space`）。O 欄の値は空き（U+0000）と空白を区別する: 打った空白・ホストが書いた空白は中身（末尾でも送る）、
 * 空きは末尾なら送らず・途中なら READ MDT で 0x40・ALT で 0x00。期待値は実機の ACS のコアがホストへ送ったバイト列
 * （`scripts/acs-probe/space-typed.txt`。O 欄 `A` の後ろに空白を打つと `c1 40`、`あ` の後ろに空白を打つと `0e 4481 0f 40 0e 0f`）
 */
const codec = codecForCcsid(930);
const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const SO = rawSentinel(0x0e);
const SI = rawSentinel(0x0f);

/** (5,10) に O 欄 12 桁（空） */
function oField(fcw = 0x80): ScreenBuffer {
  const buf = new ScreenBuffer();
  applyDataStream(
    Uint8Array.from([ESC, COMMAND.CLEAR_UNIT, ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00, ORDER.SBA, 5, 9, ORDER.SF, 0x40, 0x00, 0x82, fcw, 0x20, 0x00, 0x0c]),
    buf,
    codec,
    () => {}
  );
  return buf;
}
const mdt = (buf: ScreenBuffer): string => hex(parseRecord(buildReadMdtResponse(buf, codec, AID.ENTER, { row: 5, col: 10 }).record).data.subarray(6));
const alt = (buf: ScreenBuffer): string => hex(parseRecord(buildReadMdtAltResponse(buf, codec, AID.ENTER, { row: 5, col: 10 }).record).data.subarray(6));
const edit = (value: string, fcw = 0x80): ScreenBuffer => {
  const buf = oField(fcw);
  buf.setFieldValue(buf.orderedFields()[0]!, value, true);
  return buf;
};

describe("継続でない O 欄の送信（空き〔NUL〕と空白）", () => {
  it("打った末尾の空白は送る（`A` ＋空白 → c1 40。READ MDT・ALT とも）", () => {
    expect(mdt(edit("A "))).toBe("c140");
    expect(alt(edit("A "))).toBe("c140");
  });
  it("半角の状態の E 欄も打った末尾の空白を送る（`A`＋空白 → c1 40）・末尾の空きは送らない", () => {
    expect(mdt(edit("A ", 0x40))).toBe("c140");
    expect(alt(edit("A ", 0x40))).toBe("c140");
    expect(mdt(edit("A\u0000\u0000", 0x40))).toBe("c1");
  });
  it("E 欄の空白も生バイト 0x40 を持つ・並びの後ろの打った空白も送る（`SO あ SI`＋空白）", () => {
    const b = edit(SO + "あ" + SI + " ", 0x40);
    expect(mdt(b)).toBe("0e44810f40");
    const f = b.orderedFields()[0]!;
    const c = b.cellAt(f.startAddr + 4);
    expect(c !== null && c?.type === "char" ? c.rawByte : undefined).toBe(0x40);
    const p = edit("A ", 0x40);
    const q = p.cellAt(p.orderedFields()[0]!.startAddr + 1);
    expect(q !== null && q?.type === "char" ? q.rawByte : undefined).toBe(0x40);
  });
  it("末尾の空きは送らない（`A` だけ）", () => {
    expect(mdt(edit("A\u0000\u0000"))).toBe("c1");
  });
  it("途中の空きは READ MDT で 0x40・ALT で 0x00", () => {
    expect(mdt(edit("A\u0000B"))).toBe("c140c2");
    expect(alt(edit("A\u0000B"))).toBe("c100c2");
  });
  it("全角の後ろに打った空白（並びを閉じたあと）も送る（`SO あ SI` ＋空白）", () => {
    expect(mdt(edit(SO + "あ" + SI + " "))).toBe("0e44810f40");
  });
  it("打った空白のセルは生バイト 0x40 を持つ（画面へ読み戻したとき、書かなかった桁〔空き〕と見分ける）", () => {
    const buf = edit("A B\u0000");
    const f = buf.orderedFields()[0]!;
    const raw = (i: number): number | undefined => {
      const c = buf.cellAt(f.startAddr + i);
      return c === null || c?.type !== "char" ? undefined : c.rawByte;
    };
    expect([raw(1), buf.cellAt(f.startAddr + 3)]).toEqual([0x40, null]);
  });
  it("ホストが RA（繰り返し）で書いた 0x40 は中身の空白、RA の 0x00 は空き", () => {
    const buf = new ScreenBuffer();
    applyDataStream(
      Uint8Array.from([
        ESC, COMMAND.CLEAR_UNIT, ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00, ORDER.SBA, 5, 9, ORDER.SF, 0x40, 0x00, 0x82, 0x80, 0x20, 0x00, 0x0c,
        ORDER.RA, 5, 12, 0x40, ORDER.RA, 5, 21, 0x00
      ]),
      buf,
      codec,
      () => {}
    );
    buf.orderedFields()[0]!.mdt = true;
    expect(mdt(buf)).toBe("404040"); // 10〜12 桁目の 3 桁（RA は目標の桁を含む）が空白、残りは空き（末尾なので送らない）
    // 画面へ読み戻すとき（web-ui の `logicalFromCells`）書かなかった桁と見分ける手がかりは生バイト 0x40
    const f = buf.orderedFields()[0]!;
    const raw = (i: number): number | undefined => {
      const c = buf.cellAt(f.startAddr + i);
      return c === null || c?.type !== "char" ? undefined : c.rawByte;
    };
    expect([raw(0), raw(2), raw(3)]).toEqual([0x40, 0x40, undefined]);
  });
  it("ホストが TD（透過データ）で書いた 0x40 も中身の空白", () => {
    const buf = new ScreenBuffer();
    applyDataStream(
      Uint8Array.from([
        ESC, COMMAND.CLEAR_UNIT, ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00, ORDER.SBA, 5, 9, ORDER.SF, 0x40, 0x00, 0x82, 0x80, 0x20, 0x00, 0x0c,
        ORDER.TD, 0x00, 0x03, 0xc1, 0x40, 0x40
      ]),
      buf,
      codec,
      () => {}
    );
    buf.orderedFields()[0]!.mdt = true;
    expect(mdt(buf)).toBe("c14040");
    const f = buf.orderedFields()[0]!;
    const c1 = buf.cellAt(f.startAddr + 1);
    expect(c1 !== null && c1?.type === "char" ? c1.rawByte : undefined).toBe(0x40);
  });
  it("空白だけの値も空きではない（`  ` → 40 40）", () => {
    expect(mdt(edit("  "))).toBe("4040");
  });
});
