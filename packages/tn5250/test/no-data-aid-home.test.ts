import { describe, it, expect } from "vitest";
import { applyDataStream } from "../src/protocol/wtd-applier.js";
import { ScreenBuffer } from "../src/screen/buffer.js";
import { buildReadMdtResponse, buildReadInputFieldsResponse, NO_DATA_AIDS } from "../src/protocol/read-response.js";
import { aidCodeOf } from "../src/session/aid-keys.js";
import { codecForCcsid } from "@ts5250/ebcdic/codec";
import { ESC, COMMAND, ORDER, AID } from "../src/protocol/constants.js";

/**
 * **欄データを載せない AID と、ホーム位置**（`20260921-home-record-backspace`）。
 *
 * ACS `DS5250.sendAid` は Clear・Help・Print・Record Backspace で**カーソルと AID だけ**を送る。実機で ACS のワイヤを採った:
 * コマンド行に `ABC` を打って Help → `00 0d 12 a0 00 00 04 00 80 03 14 0a f3`（13 バイト。欄データ無し）、
 * ホーム位置で Home → `… 03 14 07 f8`。以前の当 PJ は他の AID と同じく MDT の欄を載せていた。
 *
 * ホーム位置は ACS `PS5250.getHomePos`: IC で指された番地、無ければ先頭の非バイパス欄、欄が無ければ 1 行 1 桁。
 */
const codec = codecForCcsid(37);
const WTD = [ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00];
const SOH = [ORDER.SOH, 7, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
/** 保護欄 (2,10) 6 桁 → 入力欄 (5,11) 6 桁 → 入力欄 (8,11) 6 桁 */
const FIELDS = [
  ORDER.SBA, 2, 9, ORDER.SF, 0x60, 0x00, 0x20, 0x00, 6,
  ORDER.SBA, 5, 10, ORDER.SF, 0x40, 0x00, 0x20, 0x00, 6,
  ORDER.SBA, 8, 10, ORDER.SF, 0x40, 0x00, 0x20, 0x00, 6
];
function screen(extra: number[] = []): ScreenBuffer {
  const buf = new ScreenBuffer();
  applyDataStream(Uint8Array.from([ESC, COMMAND.CLEAR_UNIT, ...WTD, ...SOH, ...FIELDS, ...extra]), buf, codec, () => {});
  return buf;
}
/** 欄 (5,11) に打った（MDT が立つ） */
function typed(buf: ScreenBuffer): ScreenBuffer {
  const f = buf.fieldAt(5, 11);
  buf.setFieldValue(f, "ABC");
  return buf;
}
const body = (rec: Uint8Array): number[] => [...rec.slice(10)]; // ヘッダ 10 バイトの後ろ

describe("欄データを載せない AID（ACS `DS5250.sendAid`）", () => {
  it.each([
    ["Help", AID.HELP],
    ["Clear", AID.CLEAR],
    ["Print", AID.PRINT],
    ["Record Backspace", AID.RECORD_BACKSPACE]
  ])("**%s は MDT の欄があってもカーソルと AID だけ**", (_label, aid) => {
    const buf = typed(screen());
    const { record } = buildReadMdtResponse(buf, codec, aid, { row: 5, col: 14 });
    expect(body(record)).toEqual([5, 14, aid]);
  });

  it("Enter は従来どおり欄を載せる（対照）", () => {
    const buf = typed(screen());
    const { record } = buildReadMdtResponse(buf, codec, AID.ENTER, { row: 5, col: 14 });
    expect(body(record).slice(0, 6)).toEqual([5, 14, AID.ENTER, ORDER.SBA, 5, 11]);
  });

  it("READ INPUT FIELDS（0x42）で待たされていても同じ（ACS は Read の種類で分けない）", () => {
    const buf = typed(screen());
    expect(body(buildReadInputFieldsResponse(buf, codec, AID.HELP, { row: 5, col: 14 }).record)).toEqual([5, 14, AID.HELP]);
    // 対照: Enter は全欄を平坦に並べる
    expect(body(buildReadInputFieldsResponse(buf, codec, AID.ENTER, { row: 5, col: 14 }).record).length).toBeGreaterThan(3);
  });

  it("Record Backspace は AID 0xF8 として送れる", () => {
    expect(aidCodeOf("RecordBackspace")).toBe(0xf8);
    expect(NO_DATA_AIDS.has(0xf8)).toBe(true);
  });
});

describe("ホーム位置（ACS `PS5250.getHomePos`）", () => {
  it("IC が無ければ先頭の非バイパス欄の先頭（保護欄は飛ばす）", () => {
    expect(screen().snapshot("s", false).home).toEqual({ row: 5, col: 11 });
  });

  it("IC があれば IC", () => {
    expect(screen([ORDER.IC, 8, 13]).snapshot("s", false).home).toEqual({ row: 8, col: 13 });
  });

  it("IC は後の WTD（IC なし）へ持ち越す（書式を消すまで）", () => {
    const buf = screen([ORDER.IC, 8, 13]);
    applyDataStream(Uint8Array.from([...WTD, ORDER.SBA, 1, 1, 0xc1]), buf, codec, () => {});
    expect(buf.snapshot("s", false).home).toEqual({ row: 8, col: 13 });
  });

  it("入力欄が無ければ 1 行 1 桁", () => {
    const buf = new ScreenBuffer();
    applyDataStream(Uint8Array.from([ESC, COMMAND.CLEAR_UNIT, ...WTD, ORDER.SBA, 3, 3, 0xc1]), buf, codec, () => {});
    expect(buf.snapshot("s", false).home).toEqual({ row: 1, col: 1 });
  });
});

describe("SAVE / RESTORE SCREEN は IC も退避・復元する（ACS `Save5250Net` の `SaveWTD_IC_addr`・`SaveHomePos`）", () => {
  // 節目の独立点検の指摘: 窓を開いて F12 で戻ると窓の IC が残り、ホーム位置が窓を指し、
  // 後続の IC 無しの WTD でカーソルが窓の位置へ飛んでいた
  const WIN_FIELD = [ORDER.SBA, 12, 30, ORDER.SF, 0x40, 0x00, 0x20, 0x00, 4];
  function mainThenWindowThenRestore(): ScreenBuffer {
    const buf = screen([ORDER.IC, 8, 13]);
    const ap = (b: number[]): void => void applyDataStream(Uint8Array.from(b), buf, codec, () => {});
    ap([ESC, COMMAND.SAVE_SCREEN]);
    ap([...WTD, ...SOH, ...WIN_FIELD, ORDER.IC, 12, 33]);
    expect(buf.snapshot("s", false).home, "前提: 窓ではホーム位置が窓の IC").toEqual({ row: 12, col: 33 });
    ap([ESC, COMMAND.RESTORE_SCREEN]);
    return buf;
  }

  it("戻した画面のホーム位置は主画面の IC", () => {
    expect(mainThenWindowThenRestore().snapshot("s", false).home).toEqual({ row: 8, col: 13 });
  });

  it("戻した後の IC 無しの WTD でカーソルは主画面の IC へ（窓の位置へ飛ばない）", () => {
    const buf = mainThenWindowThenRestore();
    applyDataStream(Uint8Array.from([...WTD, ORDER.SBA, 24, 1, 0xc1]), buf, codec, () => {});
    expect(buf.snapshot("s", false).cursor).toEqual({ row: 8, col: 13 });
  });
});
