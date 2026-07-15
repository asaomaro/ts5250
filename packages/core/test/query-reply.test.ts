import { describe, it, expect } from "vitest";
import { buildQueryReply } from "../src/protocol/query-reply.js";
import { parseRecord } from "../src/protocol/gds.js";
import { applyDataStream } from "../src/protocol/wtd-applier.js";
import { ScreenBuffer } from "../src/screen/buffer.js";
import { codecForCcsid } from "../src/codec/codec.js";
import { OPCODE, ESC, COMMAND } from "../src/protocol/constants.js";

const codec = codecForCcsid(37);

describe("buildQueryReply", () => {
  it("NO_OP レコードに 61 バイトの Query Reply を載せる", () => {
    const parsed = parseRecord(buildQueryReply());
    expect(parsed.opcode).toBe(OPCODE.NOOP);
    const d = parsed.data;
    expect(d).toHaveLength(61);
    expect(d[2]).toBe(0x88); // Inbound WSF AID
    expect(d[5]).toBe(0xd9); // command class
    expect(d[6]).toBe(0x70); // Query
    // device type "3179" model "02" が EBCDIC で入っている
    expect([...d.slice(30, 34)]).toEqual([0xf3, 0xf1, 0xf7, 0xf9]);
    expect([...d.slice(35, 37)]).toEqual([0xf0, 0xf2]);
    // 非拡張: 長さ 0x3A、capability t[53]/t[54] は 0
    expect(d[4]).toBe(0x3a);
    expect(d[53]).toBe(0x00);
    expect(d[54]).toBe(0x00);
  });

  it("enhanced=true で拡張 5250 を広告する（長さ 67・capability ビット）", () => {
    const parsed = parseRecord(buildQueryReply("IBM-3179-2", true));
    const d = parsed.data;
    expect(d).toHaveLength(67);
    expect(d[4]).toBe(0x40); // Query Reply 長 = 64
    expect(d[53]).toBe(0x02); // 拡張 5250 FCW & WDSF
    expect(d[54]).toBe(0x80); // 拡張 UI レベル 2
    // 末尾（55..66）はゼロ
    expect([...d.slice(55, 67)].every((b) => b === 0)).toBe(true);
  });
});

describe("applyDataStream — WSF QUERY 検出", () => {
  it("QUERY コマンド（class D9 / type 70）で queryRequested が立つ", () => {
    const buf = new ScreenBuffer();
    // ESC WSF, length=0x0005, class=0xD9, type=0x70, flag=0x00
    const data = Uint8Array.from([ESC, COMMAND.WRITE_STRUCTURED_FIELD, 0x00, 0x05, 0xd9, 0x70, 0x00]);
    const result = applyDataStream(data, buf, codec);
    expect(result.queryRequested).toBe(true);
  });

  it("QUERY 以外の構造化フィールドでは queryRequested は立たない", () => {
    const buf = new ScreenBuffer();
    const data = Uint8Array.from([ESC, COMMAND.WRITE_STRUCTURED_FIELD, 0x00, 0x05, 0xd9, 0x50, 0x00]);
    const result = applyDataStream(data, buf, codec);
    expect(result.queryRequested).toBe(false);
  });
});
