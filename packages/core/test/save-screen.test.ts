import { describe, it, expect } from "vitest";
import { ScreenBuffer } from "../src/screen/buffer.js";
import { applyDataStream } from "../src/protocol/wtd-applier.js";
import { buildSaveScreenResponse } from "../src/protocol/save-screen.js";
import { codecForCcsid } from "../src/codec/codec.js";
import { OPCODE, COMMAND, ESC } from "../src/protocol/constants.js";

/**
 * SAVE SCREEN は「退避しろ」という一方向の指示ではなく、**端末に画面を送り返させる要求**。
 * 返信しないとホストは待ち続ける（SEU の F1 でヘルプが 30 秒返らなかった原因）。
 *
 * 「送っている」だけでは足りないので、**送ったストリームを適用し直して画面が再現するか**まで見る。
 */
const codec = codecForCcsid(37);

/** ホストの WTD を1本適用して画面を作る */
function screenWith(stream: number[]): ScreenBuffer {
  const buf = new ScreenBuffer();
  applyDataStream(Uint8Array.from(stream), buf, codec, () => {});
  return buf;
}

/** 応答レコードから GDS ヘッダ（10 バイト）を外し、先頭の ESC RESTORE_SCREEN も外す */
function restoreStream(record: Uint8Array): Uint8Array {
  expect(record[9], "opcode は RESTORE_SCREEN").toBe(OPCODE.RESTORE_SCREEN);
  expect(record[10], "ESC で始まる").toBe(ESC);
  expect(record[11], "RESTORE SCREEN コマンド").toBe(COMMAND.RESTORE_SCREEN);
  return record.slice(12);
}

describe("SAVE SCREEN 応答", () => {
  it("opcode と先頭コマンドが RESTORE SCREEN になっている", () => {
    const buf = screenWith([ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00, 0x11, 1, 1, 0xc1, 0xc2]);
    const rec = buildSaveScreenResponse(buf, codec);
    restoreStream(rec); // 期待は restoreStream 内で検証
  });

  it("文字と属性が往復しても同じ画面になる", () => {
    // 属性(0x20)＋文字、離れた位置にもう1つ
    const buf = screenWith([
      ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00,
      0x11, 1, 1, 0x20, 0xc8, 0xc5, 0xd3, 0xd3, 0xd6, // 行1: 属性 + HELLO
      0x11, 5, 10, 0x28, 0xe6, 0xd6, 0xd9, 0xd3, 0xc4 // 行5桁10: 別属性 + WORLD
    ]);
    const back = new ScreenBuffer();
    applyDataStream(restoreStream(buildSaveScreenResponse(buf, codec)), back, codec, () => {});
    expect(back.snapshot("s", false).cells).toEqual(buf.snapshot("s", false).cells);
  });

  it("入力フィールドの定義（位置・長さ・属性）が往復しても保たれる", () => {
    const buf = screenWith([
      ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00,
      0x11, 3, 5, // SBA 行3桁5
      0x1d, 0x40, 0x00, 0x20, 0x00, 0x08, // SF FFW=0x4000 属性=0x20 長さ=8
      0xc1, 0xc2, 0xc3 // 中身 ABC
    ]);
    const back = new ScreenBuffer();
    applyDataStream(restoreStream(buildSaveScreenResponse(buf, codec)), back, codec, () => {});

    const orig = buf.orderedFields();
    const round = back.orderedFields();
    expect(round.length).toBe(orig.length);
    expect(round[0]).toMatchObject({
      startAddr: orig[0]!.startAddr,
      length: orig[0]!.length,
      ffw: orig[0]!.ffw,
      attrByte: orig[0]!.attrByte
    });
    expect(back.fieldValue(round[0]!)).toBe(buf.fieldValue(orig[0]!));
  });

  it("空の画面でも壊れない", () => {
    const buf = new ScreenBuffer();
    const back = new ScreenBuffer();
    applyDataStream(restoreStream(buildSaveScreenResponse(buf, codec)), back, codec, () => {});
    expect(back.snapshot("s", false).cells).toEqual(buf.snapshot("s", false).cells);
  });
});
