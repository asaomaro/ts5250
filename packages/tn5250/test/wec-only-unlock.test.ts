import { describe, it, expect } from "vitest";
import { Session5250 } from "../src/session/session.js";
import { buildRecord, parseRecord } from "../src/protocol/gds.js";
import { ESC, COMMAND, ORDER, OPCODE, AID } from "../src/protocol/constants.js";
import { codecForCcsid } from "@ts5250/ebcdic/codec";
import type { Transport } from "../src/transport/types.js";

/**
 * **READ の無い WRITE ERROR CODE だけのレコードでも施錠を解き、READ が出るまでに押した AID は溜めて次の READ で送る**（`20260927-wec-only-unlock`）。
 * ACS `processWriteErrorCode` → `initKeyboard`（エラー状態なら解く）と `pending_aid` / `checkPendingAid`。実機の ACS のコア（`scripts/acs-probe/wec-only-unlock.txt`）:
 * 0x21 だけの後は inhibit 5、Reset で解け、`AB` を打って Enter → 10 秒後の READ MDT が `05 0c f1 11 05 0a c1 c2`（カーソル 5,12・F1・欄 AB）を受けた
 */
const codec = codecForCcsid(37);
const e = (s: string): number[] => [...codec.encode(s).bytes];
const READ = [ESC, COMMAND.READ_MDT_FIELDS, 0x00, 0x00];
const frame = (opcode: number, data: number[]): number[] => {
  const out: number[] = [];
  for (const b of buildRecord(opcode, Uint8Array.from(data))) {
    out.push(b);
    if (b === 0xff) out.push(0xff);
  }
  return [...out, 0xff, 0xef];
};
const tick = () => new Promise((r) => setTimeout(r, 10));
const screen = [ESC, COMMAND.CLEAR_UNIT, ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00, ORDER.SBA, 5, 9, ORDER.SF, 0x40, 0x00, 0x24, 0x00, 0x0a, ORDER.IC, 5, 10];

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
  const feed = (b: number[]) => onData?.(Uint8Array.from(b));
  const p = Session5250.connect({ id: "t", transport, negotiationTimeoutMs: 500 });
  await tick();
  feed(frame(OPCODE.PUT_GET, [...screen, ...READ]));
  const s = await p;
  /** 送った最後のレコードのデータ（IAC EOR を外す） */
  const lastSent = () => [...parseRecord(written.at(-1)!.subarray(0, -2)).data];
  return { s, feed, written, lastSent };
}

describe("READ の無い WRITE ERROR CODE", () => {
  it("**施錠を解き、AID の待ちはエラーの画面で解く**", async () => {
    const { s, feed } = await open();
    const first = s.sendAid("Enter", { timeoutMs: 1000 });
    expect(s.snapshot().keyboardLocked).toBe(true);
    feed(frame(OPCODE.PUT_GET, [ESC, COMMAND.WRITE_ERROR_CODE, 0x22, ...e("ERR")]));
    await tick();
    const r = await first;
    expect(r.timedOut).toBe(false);
    expect(r.screen.systemMessage).toBe("ERR");
    expect(s.snapshot().keyboardLocked).toBe(false);
  });

  it("**READ が出るまでに押した AID は送らずに溜め、次の READ でそのときの画面（カーソル・欄）で送る**", async () => {
    const { s, feed, written, lastSent } = await open();
    void s.sendAid("Enter", { timeoutMs: 1000 });
    feed(frame(OPCODE.PUT_GET, [ESC, COMMAND.WRITE_ERROR_CODE, 0x22, ...e("ERR")]));
    await tick();
    s.dismissHostError();
    s.setField({ index: 1 }, "AB");
    const n = written.length;
    const second = s.sendAid("Enter", { cursor: { row: 5, col: 12 }, timeoutMs: 1000 });
    await tick();
    expect(written.length, "READ が出ていないので送らない").toBe(n);
    expect(s.snapshot().keyboardLocked).toBe(true);
    let settled = false;
    void second.then(() => (settled = true));
    feed(frame(OPCODE.PUT_GET, READ));
    await tick();
    expect(written.length).toBe(n + 1);
    expect(lastSent()).toEqual([5, 12, AID.ENTER, ORDER.SBA, 5, 10, ...e("AB")]);
    expect(s.snapshot().keyboardLocked, "送った AID の応答を待つ間は施錠").toBe(true);
    expect(settled, "READ のレコードそのものでは待ちを解かない").toBe(false);
    // 待ちは溜めた AID の応答で解ける
    feed(frame(OPCODE.PUT_GET, [ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00, ...READ]));
    expect((await second).timedOut).toBe(false);
  });

  it("**溜めた AID のカーソルは押したときの位置**（ACS の WECONLYW: `05 0c f1 …`。実測の WTD に IC は無かった——ここで明示の IC を置くのは外挿〔decisions D2〕）", async () => {
    const { s, feed, lastSent } = await open();
    void s.sendAid("Enter", { timeoutMs: 1000 });
    feed(frame(OPCODE.PUT_GET, [ESC, COMMAND.WRITE_ERROR_CODE, 0x22, ...e("ERR")]));
    await tick();
    s.dismissHostError();
    s.setField({ index: 1 }, "AB");
    void s.sendAid("Enter", { cursor: { row: 5, col: 12 }, timeoutMs: 1000 }).catch(() => undefined);
    feed(frame(OPCODE.PUT_GET, [ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x08, ORDER.SBA, 11, 2, ...e("NEXT"), ORDER.IC, 5, 10, ...READ]));
    await tick();
    expect(lastSent().slice(0, 3)).toEqual([5, 12, AID.ENTER]);
  });

  it("READ が出ているときは従来どおりすぐ送る（対照）", async () => {
    const { s, written } = await open();
    const n = written.length;
    void s.sendAid("Enter", { timeoutMs: 1000 });
    expect(written.length).toBe(n + 1);
  });

  /** 0x21 だけ → Reset → Enter を溜めた状態にする */
  async function deferredEnter() {
    const o = await open();
    void o.s.sendAid("Enter", { timeoutMs: 1000 });
    o.feed(frame(OPCODE.PUT_GET, [ESC, COMMAND.WRITE_ERROR_CODE, 0x22, ...e("ERR")]));
    await tick();
    o.s.dismissHostError();
    void o.s.sendAid("Enter", { timeoutMs: 1000 }).catch(() => undefined);
    return { ...o, n: o.written.length };
  }

  it("**後の WRITE ERROR CODE は溜めた AID を捨てる**（ACS `initKeyboard` の `pending_aid = 0`。実機の ACS のコア `wec-twice.txt`: 2 回目の 0x21 の後の READ は後で押した F3 を受けた）", async () => {
    const { s, feed, written, n } = await deferredEnter();
    feed(frame(OPCODE.PUT_GET, [ESC, COMMAND.WRITE_ERROR_CODE, 0x22, ...e("ERR2")]));
    await tick();
    feed(frame(OPCODE.PUT_GET, READ));
    await tick();
    expect(written.length, "溜めた Enter は送らない").toBe(n);
    expect(s.snapshot().keyboardLocked).toBe(false);
  });

  it("~~CC1 の施錠も溜めた AID を捨てる~~ → **捨てない**（実機の ACS のコアのワイヤ: CC1 0x20 の WTD を含む READ のレコードの後に溜めた Enter を送った）", async () => {
    const { feed, written, n, lastSent } = await deferredEnter();
    feed(frame(OPCODE.PUT_GET, [ESC, COMMAND.WRITE_TO_DISPLAY, 0x20, 0x00, ...READ]));
    await tick();
    expect(written.length).toBe(n + 1);
    expect(lastSent().slice(0, 3)).toEqual([5, 10, AID.ENTER]);
  });

  it("Attn は溜めた AID を捨てる（Attn の窓の READ に古い Enter を送らない。decisions D2）", async () => {
    const { s, feed, written, n } = await deferredEnter();
    void s.sendAid("Attn");
    feed(frame(OPCODE.PUT_GET, READ));
    await tick();
    expect(written.length, "Attn のフラグレコードだけ").toBe(n + 1);
  });
});
