import { describe, it, expect } from "vitest";
import { Session5250 } from "../src/session/session.js";
import { OPCODE } from "../src/protocol/constants.js";
import type { Transport } from "../src/transport/types.js";

/**
 * **READ SCREEN の応答は、命令の時点の画面で組む**（`20260929-response-content-timing`）。実機の ACS のコア（DSM の READSCRTIMING・
 * `scripts/verify-read-screen-timing.mjs`）で、1 本のレコードの `[READ SCREEN][WTD で (5,10) を OLD→NEW]` の応答は OLD、
 * 対照の `[WTD][READ SCREEN]` は NEW だった（ワイヤ。ACS は READ SCREEN の命令に達した時点で画面を送る）。
 * ~~レコードを適用し終えた画面で組む~~ と、前者の応答に後ろの WTD の NEW が入っていた
 */
const IAC_EOR = [0xff, 0xef];
const ESC = 0x04;
const OLD = [0xd6, 0xd3, 0xc4];
const NEW = [0xd5, 0xc5, 0xe6];

function fakeTransport(): { transport: Transport; written: Uint8Array[]; feed: (b: number[]) => void } {
  const written: Uint8Array[] = [];
  let onData: ((d: Uint8Array) => void) | undefined;
  const transport = {
    onData: (cb: (d: Uint8Array) => void) => {
      onData = cb;
    },
    onClose: () => {},
    onError: () => {},
    send: (d: Uint8Array) => {
      written.push(d);
    },
    close: () => {}
  } as unknown as Transport;
  return { transport, written, feed: (b) => onData?.(Uint8Array.from(b)) };
}

/** GDS レコード（ヘッダ 10 バイト＋データ）を telnet の IAC EOR 付きで */
function record(opcode: number, data: number[]): number[] {
  const len = 10 + data.length;
  return [(len >> 8) & 0xff, len & 0xff, 0x12, 0xa0, 0x00, 0x00, 0x04, 0x00, 0x00, opcode, ...data, ...IAC_EOR];
}
const writeAt = (text: number[]): number[] => [ESC, 0x11, 0x00, 0x00, 0x11, 0x05, 0x0a, ...text]; // WTD: (5,10) に text
const READ_SCREEN = [ESC, 0x62];

const has = (rec: Uint8Array, pat: number[]): boolean => {
  for (let i = 0; i + pat.length <= rec.length; i++) if (pat.every((v, j) => rec[i + j] === v)) return true;
  return false;
};

/** (5,10) に OLD を出してから、`second` のデータを 1 本のレコードで受け、READ SCREEN の応答（画面）を返す */
async function readScreenReply(second: number[]): Promise<Uint8Array> {
  const { transport, written, feed } = fakeTransport();
  const p = Session5250.connect({ id: "t", transport, negotiationTimeoutMs: 300 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 30));
  feed(record(OPCODE.OUTPUT_ONLY, writeAt(OLD)));
  await new Promise((r) => setTimeout(r, 30));
  const before = written.length;
  feed(record(OPCODE.READ_SCREEN, second));
  await new Promise((r) => setTimeout(r, 30));
  const rec = written.slice(before).find((d) => d[9] === OPCODE.READ_SCREEN);
  expect(rec, "READ SCREEN の応答が含まれる").toBeDefined();
  await p;
  return rec!;
}

describe("READ SCREEN の応答の中身（命令の時点の画面）", () => {
  it("**[READ SCREEN][WTD で OLD→NEW]**: 応答は書き換え前の OLD（ACS の実機のワイヤ）", async () => {
    const rec = await readScreenReply([...READ_SCREEN, ...writeAt(NEW)]);
    expect(has(rec, OLD), "OLD が入る").toBe(true);
    expect(has(rec, NEW), "NEW は入らない").toBe(false);
  });

  it("**READ SCREEN TO PRINT（0x66）も同じ**: [READ SCREEN TO PRINT][WTD で OLD→NEW] の応答は OLD（独立点検の指摘: 別の case で積む枠）", async () => {
    const rec = await readScreenReply([ESC, 0x66, ...writeAt(NEW)]);
    expect(has(rec, OLD), "OLD が入る").toBe(true);
    expect(has(rec, NEW), "NEW は入らない").toBe(false);
  });

  it("**[WTD で OLD→NEW][READ SCREEN]**（対照）: 応答は書き換え後の NEW", async () => {
    const rec = await readScreenReply([...writeAt(NEW), ...READ_SCREEN]);
    expect(has(rec, NEW), "NEW が入る").toBe(true);
    expect(has(rec, OLD), "OLD は入らない").toBe(false);
  });
});
