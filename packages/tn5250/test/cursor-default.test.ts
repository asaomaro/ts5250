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
  // ~~IC が無ければ cursorSet は false（呼び出し側が READ のときに先頭の入力欄へ寄せる）~~——既定位置も WTD の終わりで
  // 置く（ACS `preprocessWCC2`。`20260921-cursor-per-wtd-acs`）。READ では触れない
  it("IC が無ければ WTD の終わりで最初の入力フィールドへ置く（cursorSet は true）", () => {
    const buf = new ScreenBuffer();
    const result = applyDataStream(screenWithOneField(false), buf, codec);
    expect(result.readRequested).toBe(true);
    expect(result.cursorSet).toBe(true);
    expect(buf.rowColOf(buf.cursorAddr)).toEqual({ row: 5, col: 11 });
  });

  it("入力欄が 1 つも無ければ 1 行 1 桁（ACS `setDefaultInsertCursor` の `homePos = 0`）", () => {
    const buf = new ScreenBuffer();
    buf.cursorAddr = buf.addrOf(10, 10);
    applyDataStream(Uint8Array.from([ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00, ORDER.SBA, 3, 3, 0xc1]), buf, codec);
    expect(buf.rowColOf(buf.cursorAddr)).toEqual({ row: 1, col: 1 });
  });

  it("CC2 の 0x40（カーソルを動かさない）なら置かない", () => {
    const buf = new ScreenBuffer();
    buf.cursorAddr = buf.addrOf(10, 10);
    const r = applyDataStream(Uint8Array.from([ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x40, ORDER.SBA, 5, 10, ORDER.SF, 0x40, 0x00, 0x20, 0x00, 8]), buf, codec);
    expect(r.cursorSet).toBe(false);
    expect(buf.rowColOf(buf.cursorAddr)).toEqual({ row: 10, col: 10 });
  });

  it("**READ だけのレコードはカーソルに触れない**（WTD と READ が別のレコードで来る画面。実機 ACS は IC のまま）", () => {
    const buf = new ScreenBuffer();
    applyDataStream(Uint8Array.from([
      ESC, COMMAND.CLEAR_UNIT,
      ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x08,
      ORDER.SBA, 5, 19, ORDER.SF, 0x40, 0x00, 0x20, 0x00, 6,
      ORDER.SBA, 7, 19, ORDER.SF, 0x40, 0x00, 0x20, 0x00, 6,
      ORDER.IC, 7, 20
    ]), buf, codec);
    expect(buf.rowColOf(buf.cursorAddr)).toEqual({ row: 7, col: 20 });
    const r = applyDataStream(Uint8Array.from([ESC, COMMAND.READ_MDT_FIELDS, 0x00, 0x00]), buf, codec);
    expect(r.cursorSet).toBe(false);
    expect(buf.rowColOf(buf.cursorAddr), "READ で先頭の入力欄 5,20 へ動いた").toEqual({ row: 7, col: 20 });
  });

  it("IC は MC を捨てる（ACS の 0x13 は `WTD_MC_addr = -1`）", () => {
    const buf = new ScreenBuffer();
    applyDataStream(Uint8Array.from([
      ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00,
      ORDER.SBA, 5, 9, ORDER.SF, 0x40, 0x00, 0x20, 0x00, 8,
      ORDER.MC, 3, 3, ORDER.IC, 12, 40
    ]), buf, codec);
    expect(buf.rowColOf(buf.cursorAddr)).toEqual({ row: 12, col: 40 });
  });

  it("**IC はレコードをまたいで持ち越す**（ACS `WTD_IC_addr` は書式を消すまで残る）", () => {
    const buf = new ScreenBuffer();
    applyDataStream(Uint8Array.from([
      ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00,
      ORDER.SBA, 5, 9, ORDER.SF, 0x40, 0x00, 0x20, 0x00, 8,
      ORDER.IC, 12, 40
    ]), buf, codec);
    buf.cursorAddr = buf.addrOf(1, 1);
    applyDataStream(Uint8Array.from([ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00, ORDER.SBA, 20, 1, 0xc1]), buf, codec);
    expect(buf.rowColOf(buf.cursorAddr)).toEqual({ row: 12, col: 40 });
  });

  it("IC があれば cursorSet が true でカーソルはその位置", () => {
    const buf = new ScreenBuffer();
    const result = applyDataStream(screenWithOneField(true), buf, codec);
    expect(result.cursorSet).toBe(true);
    expect(buf.rowColOf(buf.cursorAddr)).toEqual({ row: 12, col: 40 });
  });

  // ~~cursorToFirstInputField は属性桁の次（フィールド先頭）へ置く~~ → メソッドごと撤去（src から呼ばれなくなった）。
  // 既定の位置は `homeAddr()`（WTD の終わりに `placeCursorAfterWtd` が使う）
  it("既定の位置（homeAddr）は属性桁の次（フィールド先頭）", () => {
    const buf = new ScreenBuffer();
    applyDataStream(screenWithOneField(false), buf, codec);
    expect(buf.rowColOf(buf.homeAddr())).toEqual({ row: 5, col: 11 });
  });
});

// **「カーソルが入力できない桁にあるか」（`cursorIsUnenterable`）の単体テストはここに
// あった**が撤去した（`.aidev/works/20260915-pr387-acs-premise-unverified`）。
// このメソッドは旧 `PR#387` 分岐（「画面は変わったのにカーソルが動かず、そこが保護欄」
// なら最初の入力欄へ寄せる）専用のヘルパーで、その分岐自体を撤去したため
// `buffer.ts` からも削除した。撤去の理由は `decisions.md` D1 参照。
