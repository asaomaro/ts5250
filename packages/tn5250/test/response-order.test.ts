import { describe, it, expect } from "vitest";
import { Session5250 } from "../src/session/session.js";
import { buildRecord, parseRecord } from "../src/protocol/gds.js";
import { ESC, COMMAND, ORDER, OPCODE } from "../src/protocol/constants.js";
import { codecForCcsid } from "@ts5250/ebcdic/codec";
import type { Transport } from "../src/transport/types.js";

/**
 * **1 本のレコードの中の応答はコマンドの順**（`20260928-response-order`）。実機の ACS のコア（DSM の RESPORDER / RESPORDER2・relay のワイヤ）:
 * オペコード 03 の `[WSF Query][SAVE SCREEN]` は Query の応答 → 退避の応答、オペコード 04 の `[SAVE SCREEN][WSF Query]` は退避の応答だけ
 * （ACS `DS5250.tokenizeData` の case 4 は `04 02` で始まれば `processSaveScreen()` だけ）
 */
const codec = codecForCcsid(37);
const e = (s: string): number[] => [...codec.encode(s).bytes];
const IAC_EOR = [0xff, 0xef];
const frame = (opcode: number, data: number[]): number[] => {
  const out: number[] = [];
  for (const b of buildRecord(opcode, Uint8Array.from(data))) {
    out.push(b);
    if (b === 0xff) out.push(0xff);
  }
  return [...out, ...IAC_EOR];
};
const QUERY = [ESC, COMMAND.WRITE_STRUCTURED_FIELD, 0x00, 0x05, 0xd9, 0x70, 0x00];
const SAVE = [ESC, COMMAND.SAVE_SCREEN];
const READ_SCREEN = [ESC, COMMAND.READ_SCREEN];
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
  const feed = (b: number[]) => onData?.(Uint8Array.from(b));
  const p = Session5250.connect({ id: "t", transport, negotiationTimeoutMs: 500 });
  await tick();
  feed(frame(OPCODE.PUT_GET, [ESC, COMMAND.CLEAR_UNIT, ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00, ORDER.SBA, 3, 2, ...e("RESP"), ESC, COMMAND.READ_MDT_FIELDS, 0x00, 0x00]));
  await p;
  /** 送ったレコードの種類（Query の応答・退避の応答・画面の読み・ほか） */
  const kinds = (from: number): string[] =>
    written.slice(from).map((w) => {
      const rec = parseRecord(w.subarray(0, w.length - 2)).data;
      if (rec[0] === 0x00 && rec[1] === 0x00 && rec[2] === 0x88) return "query";
      if (rec[0] === ESC && rec[1] === COMMAND.RESTORE_SCREEN) return "save";
      return "other";
    });
  return { feed, written, kinds };
}

describe("応答の順（ACS の実測）", () => {
  it("オペコード 03 の `[WSF Query][SAVE SCREEN]` は Query の応答が先（RESPORDER）", async () => {
    const t = await open();
    const at = t.written.length;
    t.feed(frame(OPCODE.PUT_GET, [...QUERY, ...SAVE]));
    await tick();
    expect(t.kinds(at)).toEqual(["query", "save"]);
  });

  it("オペコード 04 の `[SAVE SCREEN][WSF Query]` は退避の応答だけ（RESPORDER2。残りを読まない）", async () => {
    const t = await open();
    const at = t.written.length;
    t.feed(frame(OPCODE.SAVE_SCREEN, [...SAVE, ...QUERY]));
    await tick();
    expect(t.kinds(at)).toEqual(["save"]);
  });

  it("オペコード 03 なら `[SAVE SCREEN][WSF Query]` は両方をその順に", async () => {
    const t = await open();
    const at = t.written.length;
    t.feed(frame(OPCODE.PUT_GET, [...SAVE, ...QUERY]));
    await tick();
    expect(t.kinds(at)).toEqual(["save", "query"]);
  });

  it("オペコード 04 でも `04 02` だけ（長さ 2）なら退避の応答", async () => {
    const t = await open();
    const at = t.written.length;
    t.feed(frame(OPCODE.SAVE_SCREEN, SAVE));
    await tick();
    expect(t.kinds(at)).toEqual(["save"]);
  });

  it("オペコード 04 でも SAVE SCREEN で始まらなければ全部読む", async () => {
    const t = await open();
    const at = t.written.length;
    t.feed(frame(OPCODE.SAVE_SCREEN, [...QUERY, ...SAVE]));
    await tick();
    expect(t.kinds(at)).toEqual(["query", "save"]);
  });

  it("READ SCREEN も出てきた順（`[READ SCREEN][SAVE SCREEN]` は画面の読みが先）", async () => {
    const t = await open();
    const at = t.written.length;
    t.feed(frame(OPCODE.PUT_GET, [...READ_SCREEN, ...SAVE]));
    await tick();
    expect(t.kinds(at)).toEqual(["other", "save"]);
  });
});
