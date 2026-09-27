import { describe, it, expect } from "vitest";
import { applyDataStream } from "../src/protocol/wtd-applier.js";
import { ScreenBuffer } from "../src/screen/buffer.js";
import { Session5250 } from "../src/session/session.js";
import { buildRecord } from "../src/protocol/gds.js";
import { codecForCcsid } from "@ts5250/ebcdic/codec";
import { ESC, COMMAND, ORDER, OPCODE } from "../src/protocol/constants.js";
import type { Transport } from "../src/transport/types.js";

/**
 * **その場で戻る否定応答の残り**（`20260927-early-return-rest`）。実機の ACS のコア（DSM の READCC2 / CUANOPARM / SPROLL・ワイヤは `tap-proxy.mjs`）:
 * - READ MDT の CC2＝メッセージ待ちを点けるは点かない（ACS は READ の CC を控えるだけ）
 * - 引数の無い CLEAR UNIT ALTERNATE は否定応答にせず画面を消す（同じレコードの WTD の CC2 も効く）
 * - SAVE PARTIAL の後ろで戻ったとき、否定応答が先で SAVE PARTIAL の応答はその後（次のレコード）
 */
const codec = codecForCcsid(37);
const apply = (stream: number[], buf = new ScreenBuffer()) => applyDataStream(Uint8Array.from(stream), buf, codec, () => {});
const e = (s: string): number[] => [...codec.encode(s).bytes];

describe("READ の CC", () => {
  it("**READ の CC2（メッセージ待ち・警報）は効かせない**", () => {
    const r = apply([ESC, COMMAND.READ_MDT_FIELDS, 0x00, 0x05]);
    expect(r.messageWaiting).toBeUndefined();
    expect(r.alarm).toBe(false);
    expect(r.readRequested).toBe(true);
  });
  it("**READ の CC1（MDT を戻す）も効かせない**（ACS は `lastReadCCbyte1` に控えるだけ）", () => {
    const buf = new ScreenBuffer();
    apply([ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00, ORDER.SBA, 5, 1, ORDER.SF, 0x40, 0x00, 0x20, 0x00, 0x05], buf);
    buf.setFieldValue(buf.fieldByIndex(1), "ABC", false);
    expect(buf.snapshot().fields[0]!.mdt).toBe(true);
    apply([ESC, COMMAND.READ_MDT_FIELDS, 0x60, 0x00], buf);
    expect(buf.snapshot().fields[0]!.mdt).toBe(true);
  });
});

describe("引数の無い CLEAR UNIT ALTERNATE", () => {
  it("**否定応答にせず画面を消し、同じレコードの WTD の CC2 は効く**", () => {
    const buf = new ScreenBuffer();
    apply([ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00, ORDER.SBA, 5, 2, ...e("OLD")], buf);
    const r = apply([ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x01, ORDER.SBA, 6, 2, ...e("CUA"), ESC, COMMAND.CLEAR_UNIT_ALTERNATE], buf);
    expect(r.senseCode).toBeUndefined();
    expect(r.messageWaiting).toBe(true);
    expect(buf.snapshot().cells[4]!.map((c) => c.char).join("").trim()).toBe("");
  });
  it("引数が 0 でなければ従来どおり 0x10030101", () => {
    expect(apply([ESC, COMMAND.CLEAR_UNIT_ALTERNATE, 0x01]).senseCode).toBe(0x10030101);
  });
});

describe("SAVE PARTIAL の後ろで戻ったときの応答の順", () => {
  it("**否定応答が先、SAVE PARTIAL の応答は次のレコードの後**", async () => {
    const written: Uint8Array[] = [];
    let onData: ((d: Uint8Array) => void) | undefined;
    const transport = {
      onData: (cb: (d: Uint8Array) => void) => (onData = cb),
      onClose: () => {}, onError: () => {},
      send: (d: Uint8Array) => written.push(d),
      close: () => {}
    } as unknown as Transport;
    const frame = (op: number, data: number[]) => {
      const out: number[] = [];
      for (const b of buildRecord(op, Uint8Array.from(data))) { out.push(b); if (b === 0xff) out.push(0xff); }
      return Uint8Array.from([...out, 0xff, 0xef]);
    };
    const READ = [ESC, COMMAND.READ_MDT_FIELDS, 0x00, 0x00];
    const p = Session5250.connect({ id: "t", transport, negotiationTimeoutMs: 500 });
    await new Promise((r) => setTimeout(r, 10));
    onData?.(frame(OPCODE.PUT_GET, [ESC, COMMAND.CLEAR_UNIT, ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00, ORDER.SBA, 5, 2, ...e("BASE"), ...READ]));
    await p;
    const n0 = written.length;
    const kinds = () => written.slice(n0).map((d) => (d[10] === 0x04 && d[11] === 0x12 ? "save" : d.some((_, i) => d[i] === 0x10 && d[i + 1] === 0x05 && d[i + 2] === 0x01 && d[i + 3] === 0x2c) ? "neg" : "other"));
    onData?.(frame(OPCODE.PUT_GET, [ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00, ORDER.SBA, 5, 2, ...e("SP"), ESC, COMMAND.SAVE_PARTIAL_SCREEN, 0, 0, 0, 0, 0, ESC, COMMAND.ROLL, 0x05, 0x0a, 0x05]));
    await new Promise((r) => setTimeout(r, 10));
    expect(kinds()).toEqual(["neg"]);
    onData?.(frame(OPCODE.PUT_GET, [ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00, ORDER.SBA, 6, 2, ...e("NEXT"), ...READ]));
    await new Promise((r) => setTimeout(r, 10));
    expect(kinds()).toEqual(["neg", "save"]);
  });

  it("**次のレコードもその場で戻ったら、さらに持ち越す**（ACS の尾部が走らない）", async () => {
    const { onData, kinds, frame, READ } = await setupSession();
    onData(frame(OPCODE.PUT_GET, [ESC, COMMAND.SAVE_PARTIAL_SCREEN, 0, 0, 0, 0, 0, ESC, COMMAND.ROLL, 0x05, 0x0a, 0x05]));
    onData(frame(OPCODE.PUT_GET, [ESC, COMMAND.ROLL, 0x05, 0x0a, 0x05]));
    await new Promise((r) => setTimeout(r, 10));
    expect(kinds()).toEqual(["neg", "neg"]);
    onData(frame(OPCODE.PUT_GET, [...READ]));
    await new Promise((r) => setTimeout(r, 10));
    expect(kinds()).toEqual(["neg", "neg", "save"]);
  });

  it("**次のレコードに SAVE PARTIAL があれば、持ち越しは上書き（送るのは新しい 1 本だけ）**（ACS の置き場は 1 つ）", async () => {
    const { onData, kinds, frame, READ } = await setupSession();
    onData(frame(OPCODE.PUT_GET, [ESC, COMMAND.SAVE_PARTIAL_SCREEN, 0, 0, 0, 0, 0, ESC, COMMAND.ROLL, 0x05, 0x0a, 0x05]));
    onData(frame(OPCODE.PUT_GET, [ESC, COMMAND.SAVE_PARTIAL_SCREEN, 0, 0, 0, 0, 0, ...READ]));
    await new Promise((r) => setTimeout(r, 10));
    expect(kinds()).toEqual(["neg", "save"]);
  });

  it("コマンドを読まないレコード（NOOP）では持ち越しを送らない", async () => {
    const { onData, kinds, frame } = await setupSession();
    onData(frame(OPCODE.PUT_GET, [ESC, COMMAND.SAVE_PARTIAL_SCREEN, 0, 0, 0, 0, 0, ESC, COMMAND.ROLL, 0x05, 0x0a, 0x05]));
    onData(frame(OPCODE.NOOP, []));
    await new Promise((r) => setTimeout(r, 10));
    expect(kinds()).toEqual(["neg"]);
  });
});

async function setupSession() {
  const written: Uint8Array[] = [];
  let cb: ((d: Uint8Array) => void) | undefined;
  const transport = {
    onData: (f: (d: Uint8Array) => void) => (cb = f),
    onClose: () => {}, onError: () => {},
    send: (d: Uint8Array) => written.push(d),
    close: () => {}
  } as unknown as Transport;
  const frame = (op: number, data: number[]) => {
    const out: number[] = [];
    for (const b of buildRecord(op, Uint8Array.from(data))) { out.push(b); if (b === 0xff) out.push(0xff); }
    return Uint8Array.from([...out, 0xff, 0xef]);
  };
  const READ = [ESC, COMMAND.READ_MDT_FIELDS, 0x00, 0x00];
  const p = Session5250.connect({ id: "t", transport, negotiationTimeoutMs: 500 });
  await new Promise((r) => setTimeout(r, 10));
  cb?.(frame(OPCODE.PUT_GET, [ESC, COMMAND.CLEAR_UNIT, ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00, ORDER.SBA, 5, 2, ...e("BASE"), ...READ]));
  await p;
  const n0 = written.length;
  const kinds = () =>
    written.slice(n0).map((d) => (d[10] === 0x04 && d[11] === 0x12 ? "save" : d.some((_, i) => d[i] === 0x10 && d[i + 1] === 0x05 && d[i + 2] === 0x01 && d[i + 3] === 0x2c) ? "neg" : "other"));
  return { onData: (d: Uint8Array) => cb?.(d), kinds, frame, READ };
}

