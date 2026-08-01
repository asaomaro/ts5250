import { describe, it, expect } from "vitest";
import { Session5250 } from "../src/session/session.js";
import { OPCODE } from "../src/protocol/constants.js";
import type { Transport } from "../src/transport/types.js";

/**
 * PUB400 実機で SEU の F1 を押したとき、ホストが返してきたのはこの 12 バイトだけだった。
 * opcode 0x04 / ESC 0x02 のいずれも SAVE SCREEN で、**ホストは端末からの返信を待っている**。
 * 返さなかったため 30 秒のタイムアウトまでヘルプが出なかった。
 */
const SAVE_SCREEN_RECORD = [
  0x00, 0x0c, 0x12, 0xa0, 0x00, 0x00, 0x04, 0x00, 0x00, 0x04, 0x04, 0x02
];
const IAC_EOR = [0xff, 0xef];

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

describe("SAVE SCREEN を受けたらホストへ返信する", () => {
  it("実機が送ってきた 12 バイトに対して RESTORE SCREEN の応答レコードを書き出す", async () => {
    const { transport, written, feed } = fakeTransport();
    const p = Session5250.connect({ id: "t", transport, negotiationTimeoutMs: 300 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 30));

    const before = written.length;
    feed([...SAVE_SCREEN_RECORD, ...IAC_EOR]);
    await new Promise((r) => setTimeout(r, 30));

    const sent = written.slice(before);
    expect(sent.length, "返信を 1 本書き出している").toBeGreaterThan(0);
    // GDS ヘッダの opcode 位置（10 バイト目）が RESTORE_SCREEN
    const rec = sent.find((d) => d[9] === OPCODE.RESTORE_SCREEN);
    expect(rec, "RESTORE SCREEN の応答が含まれる").toBeDefined();

    await p;
  });
});
