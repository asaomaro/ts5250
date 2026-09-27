import { describe, it, expect } from "vitest";
import { Session5250 } from "../src/session/session.js";
import { buildRecord } from "../src/protocol/gds.js";
import { ESC, COMMAND, ORDER, OPCODE } from "../src/protocol/constants.js";
import { codecForCcsid } from "@ts5250/ebcdic/codec";
import type { Transport } from "../src/transport/types.js";

/**
 * **ホストのエラーのメッセージを出している間は、ホストの WTD を止めて待ち、エラー状態を抜けてから流す**（`20260927-host-error-hold`）。
 * ACS `DS5250.checkContention`: WTD の処理の頭でデータ処理のスレッドが止まり、後ろのレコードも並ぶ。実機の ACS のコアで、
 * エラーの間に来た WTD（24 行へ NEW LINE24）は Reset の後に画面に出た（`20260927-error-msgline-wtd` research F1）。
 */
const codec = codecForCcsid(37);
const e = (s: string): number[] => [...codec.encode(s).bytes];
const IAC_EOR = [0xff, 0xef];
const READ = [ESC, COMMAND.READ_MDT_FIELDS, 0x00, 0x00];
const frame = (opcode: number, data: number[]): number[] => {
  const out: number[] = [];
  for (const b of buildRecord(opcode, Uint8Array.from(data))) {
    out.push(b);
    if (b === 0xff) out.push(0xff);
  }
  return [...out, ...IAC_EOR];
};
const wtd = (row: number, text: string): number[] => [ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00, ORDER.SBA, row, 2, ...e(text)];
const wec = (text: string): number[] => [ESC, COMMAND.WRITE_ERROR_CODE, 0x22, ...e(text)];
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
  feed(frame(OPCODE.PUT_GET, [ESC, COMMAND.CLEAR_UNIT, ...wtd(24, "ORIGINAL"), ORDER.SBA, 5, 2, ...e("BASE"), ...READ]));
  const s = await p;
  const row = (n: number) => s.snapshot().cells[n - 1]!.map((c) => c.char).join("").trim();
  return { s, feed, row, written };
}

describe("ホストのエラーの間の WTD の保留", () => {
  it("**エラーの間に来た WTD は止め、後ろのレコードも溜める。抜けると順に流れる**", async () => {
    const { s, feed, row } = await open();
    feed(frame(OPCODE.PUT_GET, [...wec("ERR"), ...READ]));
    await tick();
    const seq = s.snapshot().systemMessageSeq!;
    expect(s.snapshot().systemMessage).toBe("ERR");
    feed(frame(OPCODE.OUTPUT_ONLY, wtd(24, "NEW")));
    feed(frame(OPCODE.OUTPUT_ONLY, wtd(5, "MORE")));
    await tick();
    expect(row(24), "止めた WTD はまだ画面に出ない").toBe("ORIGINAL");
    expect(row(5), "後ろのレコードも溜まる").toBe("BASE");
    expect(s.dismissHostError(seq)).toBe(true);
    expect(s.snapshot().systemMessage).toBeUndefined();
    expect(row(24)).toBe("NEWGINAL");
    expect(row(5)).toBe("MORE");
  });

  it("**同じレコードの WEC の後ろの WTD も止める**（抜けると後ろの READ も処理される）", async () => {
    const { s, feed, row } = await open();
    feed(frame(OPCODE.PUT_GET, [...wec("ERR"), ...wtd(5, "SAME"), ...READ]));
    await tick();
    expect(row(5)).toBe("BASE");
    s.dismissHostError();
    expect(row(5)).toBe("SAME");
  });

  it("**溜めた順に流す**（同じ桁へ AAA → B は BAA。逆順なら AAA）", async () => {
    const { s, feed, row } = await open();
    feed(frame(OPCODE.PUT_GET, [...wec("ERR"), ...READ]));
    await tick();
    feed(frame(OPCODE.OUTPUT_ONLY, wtd(6, "AAA")));
    feed(frame(OPCODE.OUTPUT_ONLY, wtd(6, "B")));
    await tick();
    s.dismissHostError();
    expect(row(6)).toBe("BAA");
  });

  it("**止めている間は WTD でないレコード（CLEAR UNIT）も後ろに並ぶ**（ACS はデータ処理ごと止まる）", async () => {
    const { s, feed, row } = await open();
    feed(frame(OPCODE.PUT_GET, [...wec("ERR"), ...READ]));
    await tick();
    feed(frame(OPCODE.OUTPUT_ONLY, wtd(6, "HELD")));
    feed(frame(OPCODE.OUTPUT_ONLY, [ESC, COMMAND.CLEAR_UNIT]));
    await tick();
    expect(row(5), "CLEAR UNIT が止めた WTD を追い越した").toBe("BASE");
    s.dismissHostError();
    expect(row(5)).toBe("");
    expect(row(6)).toBe("");
  });

  it("エラーが無ければ止めない（従来どおり）", async () => {
    const { feed, row } = await open();
    feed(frame(OPCODE.OUTPUT_ONLY, wtd(5, "FREE")));
    await tick();
    expect(row(5)).toBe("FREE");
  });

  it("別のエラーの番号では抜けない（画面の側の古いエラーで新しいエラーを消さない）", async () => {
    const { s, feed, row } = await open();
    feed(frame(OPCODE.PUT_GET, [...wec("ERR"), ...READ]));
    await tick();
    const seq = s.snapshot().systemMessageSeq!;
    feed(frame(OPCODE.OUTPUT_ONLY, wtd(5, "HELD")));
    await tick();
    expect(s.dismissHostError(seq + 1000)).toBe(false);
    expect(row(5)).toBe("BASE");
    expect(s.snapshot().systemMessage).toBe("ERR");
  });

  it("**AID を送るとエラー状態を抜けてから送る**（MCP など画面の無い呼び出しでも止めた出力が流れる）", async () => {
    const { s, feed, row } = await open();
    feed(frame(OPCODE.PUT_GET, [...wec("ERR"), ...READ]));
    await tick();
    feed(frame(OPCODE.OUTPUT_ONLY, wtd(5, "HELD")));
    await tick();
    void s.sendAid("Enter", { timeoutMs: 50 }).catch(() => {});
    expect(row(5)).toBe("HELD");
    expect(s.snapshot().systemMessage).toBeUndefined();
  });

  it("CLEAR UNIT でエラー状態が解けたら、その後の WTD は止めない（ACS `processClearUnit` の `clearErrorMode`）", async () => {
    const { feed, row } = await open();
    feed(frame(OPCODE.PUT_GET, [...wec("ERR"), ...READ]));
    await tick();
    feed(frame(OPCODE.OUTPUT_ONLY, [ESC, COMMAND.CLEAR_UNIT, ...wtd(5, "AFTER")]));
    await tick();
    expect(row(5)).toBe("AFTER");
  });

  it("**同じレコードの READ まで溜まっても、AID の待ちはエラーの画面で解く**（時間切れまで待たない）", async () => {
    const { s, feed } = await open();
    const t0 = Date.now();
    const p = s.sendAid("Enter", { timeoutMs: 5000 });
    await tick();
    feed(frame(OPCODE.PUT_GET, [...wec("ERR"), ...wtd(5, "SAME"), ...READ]));
    const r = await p;
    expect(r.timedOut).toBe(false);
    expect(r.screen.systemMessage).toBe("ERR");
    // ACS は WEC の処理でエラー状態なら施錠を解く（`DS5250.initKeyboard`）——抜けるキー（矢印・Reset）も打てる
    expect(r.screen.keyboardLocked).toBe(false);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("**Attn でも抜ける**（抜けないと、ホストが Attn に返す CANCEL INVITE まで溜まって応答が出ない）", async () => {
    const { s, feed, row } = await open();
    feed(frame(OPCODE.PUT_GET, [...wec("ERR"), ...READ]));
    await tick();
    feed(frame(OPCODE.OUTPUT_ONLY, wtd(5, "HELD")));
    await tick();
    void s.sendAid("Attn", { timeoutMs: 50 }).catch(() => {});
    expect(row(5)).toBe("HELD");
  });

  it("溜めすぎたら（上限 500 本）エラー状態を抜けて流す（ホストの出力を失わない）", async () => {
    const { s, feed, row } = await open();
    feed(frame(OPCODE.PUT_GET, [...wec("ERR"), ...READ]));
    await tick();
    for (let i = 0; i < 502; i++) feed(frame(OPCODE.OUTPUT_ONLY, wtd(5, i === 501 ? "LAST" : "X")));
    await tick();
    expect(s.snapshot().systemMessage).toBeUndefined();
    expect(row(5)).toBe("LAST");
  });
});

