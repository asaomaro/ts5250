import { describe, it, expect } from "vitest";
import { Session5250 } from "../src/session/session.js";
import { buildRecord } from "../src/protocol/gds.js";
import { ESC, COMMAND, ORDER, OPCODE } from "../src/protocol/constants.js";
import type { Transport } from "../src/transport/types.js";

/**
 * **`Session5250.setField` の `opts.eitherDbcsOn` は画面バッファまで届く**（`20260927-either-field-so`）。
 * 全角の状態のまま空にした E 欄は先頭に SO を残し、READ で `0e` を送る（実機の ACS のコア。`scripts/acs-probe/either-empty.txt`）
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
  const p = Session5250.connect({ id: "t", transport, ccsid: 930, negotiationTimeoutMs: 500 });
  await tick();
  // (17,10) の E 欄 12 桁に `SO あ SI`（ホストが書いた全角の状態）
  onData?.(Uint8Array.from(frame(OPCODE.PUT_GET, [
    ESC, COMMAND.CLEAR_UNIT, ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00,
    ORDER.SBA, 17, 9, ORDER.SF, 0x40, 0x00, 0x82, 0x40, 0x24, 0x00, 0x0c, 0x0e, 0x44, 0x82, 0x0f,
    ORDER.IC, 17, 10, ESC, COMMAND.READ_MDT_FIELDS, 0x00, 0x00
  ])));
  const s = await p;
  return { s, written };
}
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

describe("setField の eitherDbcsOn（セッション経由）", () => {
  it("**全角のまま空にした**と渡すと、READ の E 欄は `0e`", async () => {
    const { s, written } = await open();
    s.setField({ row: 17, col: 10 }, "", { eitherDbcsOn: true });
    void s.sendAid("Enter", { timeoutMs: 50 }).catch(() => {});
    await tick();
    expect(hex(written.at(-1)!)).toContain("11110a0e");
  });

  it("**半角へ切り替えて空にした**と渡すと、E 欄の値は空（SO を置かない）・状態は半角", async () => {
    const { s, written } = await open();
    expect(s.snapshot().fields.find((f) => f.row === 17)?.eitherDbcsOn, "前提: ホストの SO で全角の状態").toBe(true);
    s.setField({ row: 17, col: 10 }, "", { eitherDbcsOn: false });
    void s.sendAid("Enter", { timeoutMs: 50 }).catch(() => {});
    await tick();
    const h = hex(written.at(-1)!);
    expect(h).toContain("11110a");
    expect(h).not.toContain("11110a0e");
    // 渡さなければ値からは推せず、ホストが書いた全角の状態が残る——渡したので半角に落ちている
    expect(s.snapshot().fields.find((f) => f.row === 17)?.eitherDbcsOn).toBeUndefined();
  });
});
