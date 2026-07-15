import { describe, it, expect } from "vitest";
import { buildReadMdtResponse, buildFlagRecord } from "../src/protocol/read-response.js";
import { parseRecord } from "../src/protocol/gds.js";
import { ScreenBuffer } from "../src/screen/buffer.js";
import { codecForCcsid } from "../src/codec/codec.js";
import { AID, ORDER, OPCODE, FFW } from "../src/protocol/constants.js";

const codec = codecForCcsid(37);

function makeBuffer(): ScreenBuffer {
  const b = new ScreenBuffer();
  b.setAttr(b.addrOf(5, 24), 0x24);
  b.addField(b.addrOf(5, 25), 10, FFW.ID_VALUE, 0x24);
  b.setAttr(b.addrOf(6, 24), 0x27);
  b.addField(b.addrOf(6, 25), 8, FFW.ID_VALUE, 0x27);
  return b;
}

describe("buildReadMdtResponse", () => {
  it("カーソル・AID・MDT フィールドを SBA 付きで構築する", () => {
    const b = makeBuffer();
    b.setFieldValue(b.fieldByIndex(1), "TARO");
    b.setFieldValue(b.fieldByIndex(2), "SECRET");
    const { record, substituted } = buildReadMdtResponse(b, codec, AID.ENTER, { row: 6, col: 33 });

    expect(substituted).toBe(0);
    const parsed = parseRecord(record);
    expect(parsed.opcode).toBe(OPCODE.PUT_GET);
    const d = [...parsed.data];
    expect(d.slice(0, 3)).toEqual([6, 33, AID.ENTER]);
    // フィールド 1: SBA(5,25) + "TARO"
    expect(d.slice(3, 6)).toEqual([ORDER.SBA, 5, 25]);
    expect(d.slice(6, 10)).toEqual([...codec.encode("TARO").bytes]);
    // フィールド 2: SBA(6,25) + "SECRET"
    expect(d.slice(10, 13)).toEqual([ORDER.SBA, 6, 25]);
    expect(d.slice(13)).toEqual([...codec.encode("SECRET").bytes]);
  });

  it("MDT の立っていないフィールドは送らない", () => {
    const b = makeBuffer();
    b.setFieldValue(b.fieldByIndex(1), "ONLY");
    const { record } = buildReadMdtResponse(b, codec, AID.F3);
    const d = [...parseRecord(record).data];
    expect(d[2]).toBe(AID.F3);
    expect(d.filter((x) => x === ORDER.SBA)).toHaveLength(1);
  });

  it("カーソル未指定時は現在のカーソル位置を使う", () => {
    const b = makeBuffer();
    b.cursorAddr = b.addrOf(3, 7);
    const { record } = buildReadMdtResponse(b, codec, AID.ENTER);
    const d = [...parseRecord(record).data];
    expect(d.slice(0, 2)).toEqual([3, 7]);
  });

  it("フィールドなし（AID のみ）の応答も作れる", () => {
    const b = new ScreenBuffer();
    const { record } = buildReadMdtResponse(b, codec, AID.PAGE_DOWN);
    const d = [...parseRecord(record).data];
    expect(d).toEqual([1, 1, AID.PAGE_DOWN]);
  });

  it("マップ不能文字は SUB で送られ substituted に計上される", () => {
    const b = makeBuffer();
    b.setFieldValue(b.fieldByIndex(1), "あ");
    const { record, substituted } = buildReadMdtResponse(b, codec, AID.ENTER);
    expect(substituted).toBe(1);
    const d = [...parseRecord(record).data];
    expect(d[6]).toBe(0x3f); // SUB
  });
});

describe("buildFlagRecord", () => {
  it("SysReq(SRQ) は SRQ フラグ・空データの NO_OP レコード", () => {
    const parsed = parseRecord(buildFlagRecord({ srq: true }));
    expect(parsed.opcode).toBe(OPCODE.NOOP);
    expect(parsed.flags.srq).toBe(true);
    expect(parsed.flags.atn).toBe(false);
    expect(parsed.data).toHaveLength(0);
  });

  it("Attn(ATN) は ATN フラグ", () => {
    const parsed = parseRecord(buildFlagRecord({ atn: true }));
    expect(parsed.flags.atn).toBe(true);
    expect(parsed.flags.srq).toBe(false);
  });
});
