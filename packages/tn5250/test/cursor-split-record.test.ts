import { describe, it, expect } from "vitest";
import { Session5250 } from "../src/session/session.js";
import type { Transport } from "../src/transport/types.js";
import { buildRecord } from "../src/protocol/gds.js";
import { ByteWriter } from "../src/protocol/bytes.js";
import { ESC, COMMAND, ORDER, OPCODE, FFW } from "../src/protocol/constants.js";
import { IAC, CMD } from "../src/telnet/constants.js";

/**
 * **WTD と READ が別のレコードで来る画面のカーソル**（`20260921-cursor-per-wtd-acs`）。
 *
 * CL の SNDF → RCVF は、ホストが「CLEAR UNIT ＋ WTD（IC あり）」と「READ MDT」を**別のレコード**で送る
 * （実機のトレースで確認。`scripts/verify-read-split-record.mjs`）。実機の ACS は IC の 7,20 に置き、
 * 当 PJ は READ のレコードで先頭の入力欄 5,20 へ動かしていた（`scripts/acs-probe/read-split-record.txt`）。
 * ACS は READ でカーソルに触れず、位置は WTD の終わりで決める（`DS5250.preprocessWCC2`）。
 */
function frame(record: Uint8Array): Uint8Array {
  const framed: number[] = [];
  for (const b of record) {
    framed.push(b);
    if (b === IAC) framed.push(IAC);
  }
  framed.push(IAC, CMD.EOR);
  return Uint8Array.from(framed);
}
class DeferredTransport implements Transport {
  private dataFn: ((data: Uint8Array) => void) | undefined;
  constructor(private readonly initial: Uint8Array) {}
  start(): void {
    this.dataFn?.(this.initial);
  }
  send(_data: Uint8Array): void {}
  close(): void {}
  onData(fn: (data: Uint8Array) => void): void {
    this.dataFn = fn;
  }
  onClose(_fn: (reason: string) => void): void {}
  onError(_fn: (err: Error) => void): void {}
  deliver(data: Uint8Array): void {
    this.dataFn?.(data);
  }
}
/** CLEAR UNIT ＋ WTD（5,20 と 7,20 に入力欄。ic を渡すと IC） */
function writeRecord(ic?: { row: number; col: number }): Uint8Array {
  const w = new ByteWriter();
  w.u8(ESC).u8(COMMAND.CLEAR_UNIT);
  w.u8(ESC).u8(COMMAND.WRITE_TO_DISPLAY).u8(0x00).u8(0x08);
  w.u8(ORDER.SBA).u8(5).u8(19).u8(ORDER.SF).u16(FFW.ID_VALUE).u8(0x20).u16(6);
  w.u8(ORDER.SBA).u8(7).u8(19).u8(ORDER.SF).u16(FFW.ID_VALUE).u8(0x20).u16(6);
  if (ic) w.u8(ORDER.IC).u8(ic.row).u8(ic.col);
  return buildRecord(OPCODE.OUTPUT_ONLY, w.toUint8Array());
}
function readRecord(): Uint8Array {
  const w = new ByteWriter();
  w.u8(ESC).u8(COMMAND.READ_MDT_FIELDS).u8(0x00).u8(0x00);
  return buildRecord(OPCODE.PUT_GET, w.toUint8Array());
}

describe("WTD と READ が別のレコードで来る画面", () => {
  it("**IC があれば、READ のレコードの後も IC のまま**（ACS 7,20。~~先頭の入力欄 5,20~~）", async () => {
    const transport = new DeferredTransport(frame(writeRecord({ row: 7, col: 20 })));
    const pending = Session5250.connect({ transport, id: "t" });
    transport.deliver(frame(readRecord()));
    const session = await pending;
    expect(session.snapshot().cursor).toEqual({ row: 7, col: 20 });
  });

  it("IC が無ければ WTD の終わりで先頭の入力欄（ACS 5,20）", async () => {
    const transport = new DeferredTransport(frame(writeRecord()));
    const pending = Session5250.connect({ transport, id: "t" });
    transport.deliver(frame(readRecord()));
    const session = await pending;
    expect(session.snapshot().cursor).toEqual({ row: 5, col: 20 });
  });
});
