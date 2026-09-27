import { describe, it, expect } from "vitest";
import { Session5250 } from "../src/session/session.js";
import { buildRecord, parseRecord } from "../src/protocol/gds.js";
import { ESC, COMMAND, ORDER, OPCODE } from "../src/protocol/constants.js";
import type { Transport } from "../src/transport/types.js";

/**
 * **PA1〜PA3 と Test Request**（`20260927-key-edit-rest`）。実機の ACS のコア（`scripts/acs-probe/pa-keys.txt`。DSM の JHOME）:
 * 7,10 に AB を打って PA1 → READ は `07 0c 6c`（欄データ無し）・PA3 → `07 0c 6b`。Test Request のワイヤは `00 0a 12 a0 00 00 04 02 00 00`
 * （ヘッダのフラグ 0x02・オペコード 0・データ無し。ホストは CANCEL INVITE を返した）
 */
const frame = (opcode: number, data: number[]): number[] => {
  const out: number[] = [];
  for (const b of buildRecord(opcode, Uint8Array.from(data))) {
    out.push(b);
    if (b === 0xff) out.push(0xff);
  }
  return [...out, 0xff, 0xef];
};
const tick = () => new Promise((r) => setTimeout(r, 10));

async function open() {
  const written: Uint8Array[] = [];
  let onData: ((d: Uint8Array) => void) | undefined;
  const transport = {
    onData: (cb: (d: Uint8Array) => void) => (onData = cb),
    onClose: () => {},
    onError: () => {},
    send: (d: Uint8Array) => written.push(d),
    close: () => {}
  } as unknown as Transport;
  const p = Session5250.connect({ id: "t", transport, negotiationTimeoutMs: 500 });
  await tick();
  onData?.(Uint8Array.from(frame(OPCODE.PUT_GET, [
    ESC, COMMAND.CLEAR_UNIT, ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00,
    ORDER.SBA, 7, 9, ORDER.SF, 0x40, 0x00, 0x24, 0x00, 0x06, ORDER.IC, 7, 10,
    ESC, COMMAND.READ_MDT_FIELDS, 0x00, 0x00
  ])));
  const s = await p;
  s.setField({ index: 1 }, "AB");
  return { s, written };
}

describe("PA1〜PA3", () => {
  it.each([
    ["PA1", 0x6c],
    ["PA2", 0x6e],
    ["PA3", 0x6b]
  ] as const)("**%s はカーソルと AID だけ**（欄データを付けない。ACS と同じ）", async (key, aid) => {
    const { s, written } = await open();
    void s.sendAid(key, { cursor: { row: 7, col: 12 }, timeoutMs: 50 });
    const d = [...parseRecord(written.at(-1)!.subarray(0, -2)).data];
    expect(d).toEqual([7, 12, aid]);
  });
});

describe("Test Request", () => {
  it("**ヘッダのフラグ 0x02・オペコード 0・データ無し**（ACS のワイヤ `00 0a 12 a0 00 00 04 02 00 00`）", async () => {
    const { s, written } = await open();
    void s.sendAid("TestRequest", { timeoutMs: 50 });
    expect([...written.at(-1)!.subarray(0, -2)]).toEqual([0x00, 0x0a, 0x12, 0xa0, 0x00, 0x00, 0x04, 0x02, 0x00, 0x00]);
  });
  it("~~施錠中でも送れる~~ → **施錠中は送らない**（ACS `keyDown` が施錠中に通すのは Attn・SysReq ほかだけ。独立点検の must）", async () => {
    const { s, written } = await open();
    void s.sendAid("Enter", { timeoutMs: 50 });
    const n = written.length;
    expect(() => s.sendAid("TestRequest")).toThrow(/locked/);
    expect(written.length).toBe(n);
  });
  it("送ったら施錠して応答を待つ（ACS の `sendAid` も Test で施錠する）", async () => {
    const { s } = await open();
    void s.sendAid("TestRequest", { timeoutMs: 50 });
    expect(s.snapshot().keyboardLocked).toBe(true);
  });
});
