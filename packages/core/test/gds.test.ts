import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseRecord, buildRecord } from "../src/protocol/gds.js";
import { ByteReader, ByteWriter } from "../src/protocol/bytes.js";
import { OPCODE, ESC, COMMAND } from "../src/protocol/constants.js";
import { parseTraceJsonl, hexToBytes } from "../src/trace/trace.js";
import { TelnetLayer } from "../src/telnet/telnet.js";
import { ReplayTransport } from "../src/trace/replay.js";
import { Tn5250Error } from "../src/errors.js";

const here = dirname(fileURLToPath(import.meta.url));

/** fixtures の trace から最初の 5250 レコードを取り出すヘルパ */
export function firstRecordFromFixture(name: string): Uint8Array {
  const entries = parseTraceJsonl(readFileSync(join(here, "fixtures", name), "utf8"));
  const t = new ReplayTransport(entries);
  const telnet = new TelnetLayer(t, { terminalType: "IBM-3179-2" });
  const records: Uint8Array[] = [];
  telnet.onRecord((r) => records.push(r));
  t.start();
  const rec = records[0];
  if (!rec) throw new Error("no record in fixture");
  return rec;
}

describe("ByteReader / ByteWriter", () => {
  it("u8/u16/bytes を読み書きできる", () => {
    const w = new ByteWriter();
    w.u8(0x12).u16(0x3456).bytes([0xab, 0xcd]);
    const r = new ByteReader(w.toUint8Array());
    expect(r.u8()).toBe(0x12);
    expect(r.u16()).toBe(0x3456);
    expect([...r.bytes(2)]).toEqual([0xab, 0xcd]);
    expect(r.remaining).toBe(0);
  });

  it("レコード末尾越えの読みは PROTOCOL_ERROR", () => {
    const r = new ByteReader(Uint8Array.from([1]));
    r.u8();
    expect(() => r.u8()).toThrow(Tn5250Error);
  });
});

describe("parseRecord / buildRecord", () => {
  it("buildRecord の出力を parseRecord で往復できる", () => {
    const data = Uint8Array.from([0xaa, 0xbb]);
    const rec = buildRecord(OPCODE.PUT_GET, data, { srq: true });
    const parsed = parseRecord(rec);
    expect(parsed.opcode).toBe(OPCODE.PUT_GET);
    expect(parsed.flags.srq).toBe(true);
    expect(parsed.flags.atn).toBe(false);
    expect([...parsed.data]).toEqual([0xaa, 0xbb]);
  });

  it("LL 不一致は PROTOCOL_ERROR", () => {
    const rec = buildRecord(OPCODE.NOOP, new Uint8Array(0));
    const broken = rec.slice(0, rec.length);
    broken[1] = 99; // LL を壊す
    expect(() => parseRecord(broken)).toThrow(/length mismatch/);
  });

  it("PUB400 実 trace のレコードを解析できる", () => {
    const rec = firstRecordFromFixture("pub400-signon.jsonl");
    const parsed = parseRecord(rec);
    expect(parsed.opcode).toBe(OPCODE.PUT_GET);
    // データは ESC CLEAR_UNIT, ESC WTD で始まる（capture 時に確認済みの構造）
    expect(parsed.data[0]).toBe(ESC);
    expect(parsed.data[1]).toBe(COMMAND.CLEAR_UNIT);
    expect(parsed.data[2]).toBe(ESC);
    expect(parsed.data[3]).toBe(COMMAND.WRITE_TO_DISPLAY);
  });

  it("hexToBytes が奇数長でないことを前提にした最小ヘルパとして動く", () => {
    expect([...hexToBytes("12a0")]).toEqual([0x12, 0xa0]);
  });
});
