import { describe, it, expect } from "vitest";
import { Session5250 } from "../src/session/session.js";
import { buildRecord } from "../src/protocol/gds.js";
import { ESC, COMMAND, ORDER, OPCODE } from "../src/protocol/constants.js";
import { rawSentinel, splitLead, SPLIT_TAIL } from "../src/screen/attr-sentinel.js";
import type { Transport } from "../src/transport/types.js";

/**
 * **区間の間で割れた全角の半分を含む値は `Session5250.setField` を通り、READ で整ったバイト列になる**（`20260930-split-char`）。
 * 実機の ACS のコア（`scripts/acs-probe/cont-o-last-lead.txt`）: `0e 4482 4487 4488 4481 4484 0f e7 40 e8 e9`。
 * 区間ごとに符号化すると並びが区間をまたぐので、桁数の検査（バイト長）は `setFieldValue` のセルの数に任せる
 */
const tick = () => new Promise((r) => setTimeout(r, 10));
const frame = (opcode: number, data: number[]): number[] => {
  const out: number[] = [];
  for (const b of buildRecord(opcode, Uint8Array.from(data))) {
    out.push(b);
    if (b === 0xff) out.push(0xff);
  }
  return [...out, 0xff, 0xef];
};
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const SO = rawSentinel(0x0e);
const SI = rawSentinel(0x0f);

describe("割れた全角の半分（セッション経由）", () => {
  it("setField は桁数の検査で弾かず、READ は並びの整ったバイト列を送る", async () => {
    const written: Uint8Array[] = [];
    let onData: ((d: Uint8Array) => void) | undefined;
    const transport = {
      onData: (cb: (d: Uint8Array) => void) => (onData = cb),
      onClose: () => {},
      onError: () => {},
      send: (d: Uint8Array) => written.push(d),
      close: () => {}
    } as unknown as Transport;
    const p = Session5250.connect({ id: "t", transport, ccsid: 930, negotiationTimeoutMs: 500 });
    await tick();
    const seg = (row: number, code: number, data: number[]): number[] => [ORDER.SBA, row, 9, ORDER.SF, 0x40, 0x00, 0x82, 0x80, 0x86, code, 0x24, 0x00, 0x08, ...data];
    onData?.(Uint8Array.from(frame(OPCODE.PUT_GET, [
      ESC, COMMAND.CLEAR_UNIT, ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00,
      ...seg(5, 0x01, [0x0e, 0x44, 0x82, 0x44, 0x84, 0x0f, 0xe7, 0x00]),
      ...seg(6, 0x03, [0xe8, 0xe9, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
      ...seg(7, 0x02, []),
      ORDER.IC, 5, 10, ESC, COMMAND.READ_MDT_FIELDS, 0x00, 0x00
    ])));
    const s = await p;
    s.setField({ index: 1 }, SO + "いきく" + splitLead("あ"));
    s.setField({ index: 2 }, SPLIT_TAIL + "え" + SI + "X\u0000YZ");
    void s.sendAid("Enter", { timeoutMs: 50 }).catch(() => {});
    await tick();
    expect(hex(written.at(-1)!)).toContain("0e448244874488448144840fe740e8e9");
  });
});
