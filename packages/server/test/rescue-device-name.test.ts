import { describe, it, expect, vi } from "vitest";
import type { Transport } from "@ts5250/tn5250";

/**
 * **スプールの救出は実際に繋がった装置名の OUTQ を見る**（`20260921-device-name-acs` の節目の点検の指摘）。
 * 設定の値（置換記号・`deviceNameRetry` の前の名前）を見ていたので、`PRT%=` なら存在しない OUTQ を、
 * `deviceNameRetry` で PRT02 に繋がったら使用中の別装置 PRT01 の OUTQ を見ていた。
 */
const queues: string[] = [];
vi.mock("../src/spool-rescue.js", async (orig) => ({
  ...(await orig<typeof import("../src/spool-rescue.js")>()),
  rescueStuckSpools: async (_c: unknown, outputQueue: string) => {
    queues.push(outputQueue);
    return [];
  }
}));
const { SessionManager } = await import("../src/session-manager.js");

const SEND = [0xff, 0xfa, 0x27, 0x01, 0xff, 0xf0];
const startup = (code: number[]): number[] => {
  const body = [0x12, 0xa0, 0x90, 0x00, 0x04, 0x00, 0x00, 0x00, 0, 0, 0, 0, 0, ...code];
  return [0x00, body.length + 2, ...body];
};
const frame = (r: number[]): number[] => [...r.flatMap((b) => (b === 0xff ? [0xff, 0xff] : [b])), 0xff, 0xef];
const E8902 = [0xf8, 0xf9, 0xf0, 0xf2];
const I902 = [0xc9, 0xf9, 0xf0, 0xf2];

async function openWith(deviceName: string, deviceNameRetry = false): Promise<string[]> {
  queues.splice(0);
  let onData: ((d: Uint8Array) => void) | undefined;
  let onClose: ((r: string) => void) | undefined;
  const transport = {
    onData: (cb: (d: Uint8Array) => void) => void (onData = cb),
    onClose: (cb: (r: string) => void) => void (onClose = cb),
    onError: () => {},
    send: () => {},
    close: () => onClose?.("closed by client"),
    start: () => {
      // 使用中（8902）→ ホストが聞き直す → 次の名前で I902
      for (const b of [SEND, frame(startup(E8902)), SEND, frame(startup(I902))]) onData?.(Uint8Array.from(b));
    }
  } as unknown as Transport;
  const mgr = new SessionManager({ rescueIntervalMs: 10, passwordLevel: async () => 3 });
  await mgr.openPrinter({ transport, host: "h", user: "u", password: "p", deviceName, ...(deviceNameRetry ? { deviceNameRetry } : {}) });
  await new Promise((r) => setTimeout(r, 60));
  const seen = [...new Set(queues)];
  mgr.closeAll();
  await new Promise((r) => setTimeout(r, 30)); // 走りかけの見張りを次のテストへ持ち越さない
  return seen;
}

describe("スプールの救出が見る OUTQ", () => {
  it("置換記号の名前は、展開して答え直した後の名前（`PRT%=` → PRTP1）", async () => {
    expect(await openWith("PRT%=")).toEqual(["PRTP1"]);
  });
  it("`deviceNameRetry` で繰り上げたら繰り上げた名前（使用中の別装置の OUTQ を見ない）", async () => {
    expect(await openWith("PRT01", true)).toEqual(["PRT02"]);
  });
});
