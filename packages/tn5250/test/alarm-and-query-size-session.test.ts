import { describe, it, expect } from "vitest";
import { Session5250 } from "../src/session/session.js";
import type { Transport } from "../src/transport/types.js";
import { buildRecord, parseRecord } from "../src/protocol/gds.js";
import { ByteWriter } from "../src/protocol/bytes.js";
import { ESC, COMMAND, ORDER, OPCODE, FFW } from "../src/protocol/constants.js";
import { IAC, CMD } from "../src/telnet/constants.js";

/**
 * セッション層の 2 点（どちらも ACS に合わせた変更）:
 *
 * - **警報（WTD の CC2 ビット 0x04）で `alarm` イベントを出す。** 以前は `ApplyResult.alarm` を
 *   立てるだけで読み手が無く、実機（ACS は `ps.ringBell()`）が鳴らす場面で無反応だった。
 *   画面を変えないレコードでも鳴るので、`screen` とは別のイベントにしている。
 * - **Query Reply の画面能力は、セッションの画面サイズを申告する**（24x80 は 0x11 / 27x132 は 0x31）。
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

/** 初期画面を 1 回流したあと、テストから任意のレコードを届けられる Transport（送信は記録する） */
class ScriptedTransport implements Transport {
  readonly sent: Uint8Array[] = [];
  private dataFn: ((data: Uint8Array) => void) | undefined;
  constructor(private readonly initial: Uint8Array) {}
  start(): void {
    this.dataFn?.(this.initial);
  }
  send(data: Uint8Array): void {
    this.sent.push(data);
  }
  close(): void {}
  onData(fn: (data: Uint8Array) => void): void {
    this.dataFn = fn;
  }
  onClose(_fn: (reason: string) => void): void {}
  onError(_fn: (err: Error) => void): void {}
  deliver(record: Uint8Array): void {
    this.dataFn?.(frame(record));
  }
}

function initialScreen(): Uint8Array {
  const w = new ByteWriter();
  w.u8(ESC).u8(COMMAND.CLEAR_UNIT);
  w.u8(ESC).u8(COMMAND.WRITE_TO_DISPLAY).u8(0x00).u8(0x08);
  w.u8(ORDER.SBA).u8(5).u8(10);
  w.u8(ORDER.SF).u16(FFW.ID_VALUE).u8(0x20).u16(6);
  w.u8(ESC).u8(COMMAND.READ_MDT_FIELDS).u8(0x00).u8(0x00);
  return frame(buildRecord(OPCODE.PUT_GET, w.toUint8Array()));
}

/** 画面を変えない WTD（CC1・CC2 だけ） */
function wtdOnly(cc2: number): Uint8Array {
  return buildRecord(OPCODE.OUTPUT_ONLY, Uint8Array.from([ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, cc2]));
}

describe("警報（CC2 0x04）で alarm イベントを出す", () => {
  it("画面を変えないレコードでも、届くたびに鳴らす", async () => {
    const transport = new ScriptedTransport(initialScreen());
    const session = await Session5250.connect({ transport, id: "t" });
    let alarms = 0;
    session.on("alarm", () => {
      alarms++;
    });
    transport.deliver(wtdOnly(0x04));
    transport.deliver(wtdOnly(0x04 | 0x08)); // 解錠と同時
    expect(alarms).toBe(2);
  });

  it("警報ビットが無ければ鳴らさない", async () => {
    const transport = new ScriptedTransport(initialScreen());
    const session = await Session5250.connect({ transport, id: "t" });
    let alarms = 0;
    session.on("alarm", () => {
      alarms++;
    });
    transport.deliver(wtdOnly(0x08));
    expect(alarms).toBe(0);
  });
});

/** 送信チャンクから GDS レコードを取り出す（IAC の二重化と末尾の IAC EOR を外す） */
function records(chunks: readonly Uint8Array[]): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (const c of chunks) {
    if (c.length < 2 || c[c.length - 2] !== IAC || c[c.length - 1] !== CMD.EOR) continue;
    const bytes: number[] = [];
    for (let i = 0; i < c.length - 2; i++) {
      bytes.push(c[i]!);
      if (c[i] === IAC && c[i + 1] === IAC) i++;
    }
    out.push(Uint8Array.from(bytes));
  }
  return out;
}

describe("Query Reply はセッションの画面サイズを申告する", () => {
  const QUERY = buildRecord(
    OPCODE.NOOP,
    Uint8Array.from([ESC, COMMAND.WRITE_STRUCTURED_FIELD, 0x00, 0x05, 0xd9, 0x70, 0x00])
  );

  it.each([
    ["24x80", "11"],
    ["27x132", "31"]
  ] as const)("%s → 画面能力 0x%s", async (screenSize, expected) => {
    const transport = new ScriptedTransport(initialScreen());
    await Session5250.connect({ transport, id: "t", screenSize, ccsid: 930 });
    const before = transport.sent.length;
    transport.deliver(QUERY);
    const replies = records(transport.sent.slice(before)).map((r) => parseRecord(r).data);
    const reply = replies.find((d) => d[5] === 0xd9 && d[6] === 0x70);
    expect(reply, "Query Reply を返している").toBeDefined();
    expect(reply![50]).toBe(parseInt(expected, 16));
  });
});
