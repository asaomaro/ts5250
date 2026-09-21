import { describe, it, expect } from "vitest";
import { Session5250 } from "../src/session/session.js";
import type { Transport } from "../src/transport/types.js";
import { buildRecord, parseRecord } from "../src/protocol/gds.js";
import { ByteWriter } from "../src/protocol/bytes.js";
import { ESC, COMMAND, ORDER, OPCODE, FFW } from "../src/protocol/constants.js";
import { IAC, CMD } from "../src/telnet/constants.js";
import { applyDataStream } from "../src/protocol/wtd-applier.js";
import { ScreenBuffer } from "../src/screen/buffer.js";
import { codecForCcsid } from "@ts5250/ebcdic/codec";

/**
 * **オペコード・WSF・否定応答の順を ACS と同じに**（`20260921-negative-responses` / `20260921-wsf-d9-72` の節目の独立点検の指摘）。
 * - ACS `DS5250.processPassthru`: NOOP・CANCEL INVITE・メッセージ灯はデータを読まない。OUTPUT ONLY・RESTORE は最初の 0x04 まで読み飛ばす。
 *   知らないオペコードは否定応答 0x10030101
 * - ACS `processCommand` の ESC 0xF3: 1 つの WSF で読むのは最初の SF だけ（長さの分だけ進めて、次は ESC を求める）。応答は WSF ごとにその場で送る
 * - 否定応答は `tokenizeData` の終わり（応答の後ろ）
 */
const codec = codecForCcsid(37);
function frame(record: Uint8Array): Uint8Array {
  const framed: number[] = [];
  for (const b of record) {
    framed.push(b);
    if (b === IAC) framed.push(IAC);
  }
  framed.push(IAC, CMD.EOR);
  return Uint8Array.from(framed);
}
class ScriptedTransport implements Transport {
  readonly sent: Uint8Array[] = [];
  private dataFn: ((data: Uint8Array) => void) | undefined;
  constructor(private readonly initial: Uint8Array) {}
  start(): void {
    this.dataFn?.(this.initial);
  }
  send(data: Uint8Array): void {
    this.sent.push(data);
  }
  close(): void {}
  onData(fn: (data: Uint8Array) => void): void {
    this.dataFn = fn;
  }
  onClose(_fn: (reason: string) => void): void {}
  onError(_fn: (err: Error) => void): void {}
  deliver(record: Uint8Array): void {
    this.dataFn?.(frame(record));
  }
}
function initialScreen(): Uint8Array {
  const w = new ByteWriter();
  w.u8(ESC).u8(COMMAND.CLEAR_UNIT);
  w.u8(ESC).u8(COMMAND.WRITE_TO_DISPLAY).u8(0x00).u8(0x08);
  w.u8(ORDER.SBA).u8(5).u8(10);
  w.u8(ORDER.SF).u16(FFW.ID_VALUE).u8(0x20).u16(6);
  w.u8(ESC).u8(COMMAND.READ_MDT_FIELDS).u8(0x00).u8(0x00);
  return frame(buildRecord(OPCODE.PUT_GET, w.toUint8Array()));
}
function records(chunks: readonly Uint8Array[]): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (const c of chunks) {
    if (c.length < 2 || c[c.length - 2] !== IAC || c[c.length - 1] !== CMD.EOR) continue;
    const bytes: number[] = [];
    for (let i = 0; i < c.length - 2; i++) {
      bytes.push(c[i]!);
      if (c[i] === IAC && c[i + 1] === IAC) i++;
    }
    out.push(Uint8Array.from(bytes));
  }
  return out;
}
/** 送った記録を「NEG センス」か「応答のデータ部の頭 8 バイト」で並べる */
const describeSent = (r: Uint8Array): string => {
  const p = parseRecord(r);
  const hex = Buffer.from(p.data).toString("hex");
  return p.flags.err ? `NEG ${hex}` : hex.slice(0, 16);
};
async function run(data: number[], opcode: number = OPCODE.PUT_GET) {
  const transport = new ScriptedTransport(initialScreen());
  const session = await Session5250.connect({ transport, id: "t" });
  const screens: unknown[] = [];
  session.on("screen", (s) => screens.push(s));
  const before = transport.sent.length;
  transport.deliver(buildRecord(opcode, Uint8Array.from(data)));
  return { sent: records(transport.sent.slice(before)).map(describeSent), session, transport, screens };
}
const QUERY_REPLY = "0000880044d97080";
const D972_REPLY = "000088000cd972c0";
const WSF = COMMAND.WRITE_STRUCTURED_FIELD;

describe("オペコードごとのデータの読み方（ACS `processPassthru`）", () => {
  it("NOOP のデータは読まない（ESC でなくても否定応答にしない）", async () => {
    expect((await run([0x99, 0x01], OPCODE.NOOP)).sent).toEqual([]);
  });

  it("メッセージ灯のデータは読まない（灯は点く）", async () => {
    const r = await run([ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00, ORDER.SBA, 1, 1, 0xc1], OPCODE.MESSAGE_LIGHT_ON);
    expect(r.sent).toEqual([]);
    expect(r.session.snapshot().cells[0]![0]!.char).toBe(" ");
    expect(r.session.snapshot().messageWaiting).toBe(true);
  });

  it("OUTPUT ONLY は最初の 0x04 まで読み飛ばしてから（先頭のゴミで否定応答にしない・後ろの WTD は効く）", async () => {
    const r = await run([0x00, 0x11, ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00, ORDER.SBA, 1, 1, 0xc1], OPCODE.OUTPUT_ONLY);
    expect(r.sent).toEqual([]);
    expect(r.session.snapshot().cells[0]![0]!.char).toBe("A");
  });

  it("PUT/GET は読み飛ばさない（先頭が ESC でなければ否定応答 0x10050121）", async () => {
    expect((await run([0x00, ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00])).sent).toEqual(["NEG 10050121"]);
  });

  it("知らないオペコードは読まずに否定応答 0x10030101", async () => {
    const r = await run([ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00, ORDER.SBA, 1, 1, 0xc1], 0x20);
    expect(r.sent).toEqual(["NEG 10030101"]);
    expect(r.session.snapshot().cells[0]![0]!.char).toBe(" ");
  });
});

describe("WSF（ACS `processCommand` の ESC 0xF3・`processWSF`）", () => {
  it("**否定応答は応答の後ろ**: Query の後ろに ESC でないバイト → Query Reply → 否定応答", async () => {
    expect((await run([ESC, WSF, 0x00, 0x05, 0xd9, 0x70, 0x00, 0x99])).sent).toEqual([QUERY_REPLY, "NEG 10050121"]);
  });

  it("1 つの WSF で読むのは最初の SF だけ: D9/72(0x40) の後ろに SF が続けば、応答のあと 0x10050121", async () => {
    expect((await run([ESC, WSF, 0x00, 0x06, 0xd9, 0x72, 0x40, 0x00, 0x00, 0x06, 0xd9, 0x72, 0x80, 0x00])).sent).toEqual([
      D972_REPLY,
      "NEG 10050121"
    ]);
  });

  it("**WSF が 2 つなら応答も 2 本**（Query と D9/72。どちらもホストが待つ）", async () => {
    expect((await run([ESC, WSF, 0x00, 0x05, 0xd9, 0x70, 0x00, ESC, WSF, 0x00, 0x06, 0xd9, 0x72, 0x40, 0x00])).sent).toEqual([
      QUERY_REPLY,
      D972_REPLY
    ]);
  });

  it("Query はフラグが 0 のときだけ応答する", async () => {
    expect((await run([ESC, WSF, 0x00, 0x05, 0xd9, 0x70, 0x01])).sent).toEqual([]);
  });

  it("**D9/72 の後ろの READ も効く**（応答を返したうえで入力待ちに入る。以前は応答の後に戻り、施錠のままだった）", async () => {
    const transport = new ScriptedTransport(initialScreen());
    const s = await Session5250.connect({ transport, id: "t" });
    transport.deliver(buildRecord(OPCODE.OUTPUT_ONLY, Uint8Array.from([ESC, COMMAND.WRITE_TO_DISPLAY, 0x20, 0x00]))); // CC1 で施錠
    expect(s.snapshot().keyboardLocked).toBe(true);
    const before = transport.sent.length;
    transport.deliver(buildRecord(OPCODE.PUT_GET, Uint8Array.from([ESC, WSF, 0x00, 0x06, 0xd9, 0x72, 0x40, 0x00, ESC, COMMAND.READ_MDT_FIELDS, 0x00, 0x08])));
    expect(records(transport.sent.slice(before)).map(describeSent)).toEqual([D972_REPLY]);
    expect(s.snapshot().keyboardLocked).toBe(false);
  });

  it("WSF だけのレコードでは画面イベントを出さない（従来どおり）", async () => {
    expect((await run([ESC, WSF, 0x00, 0x05, 0xd9, 0x70, 0x00])).screens).toEqual([]);
  });

  it("長さと class・type が読めない WSF は 0x10050121", async () => {
    expect((await run([ESC, WSF, 0x00, 0x05])).sent).toEqual(["NEG 10050121"]);
  });
});

/**
 * **否定応答を立てたらレコードの残りは読まない**（ACS `processCommand` は CUA・ROLL で return し、WSF 0x80 では `sense_code` でループを抜ける）。
 * 以前のテストは否定応答の後ろにコマンドを置いておらず、`return finish()` を外しても落ちなかった（節目の点検の指摘）
 */
describe("否定応答の後ろのコマンドは読まない", () => {
  const TAIL = [ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00, ORDER.SBA, 1, 1, 0xc1, ESC, COMMAND.READ_MDT_FIELDS, 0x00, 0x08];
  const apply = (head: number[]) => {
    const buf = new ScreenBuffer();
    const r = applyDataStream(Uint8Array.from([...head, ...TAIL]), buf, codec);
    return { r, a: buf.snapshot("s").cells[0]![0]!.char };
  };
  it.each([
    ["ROLL の指定が不正", [ESC, COMMAND.ROLL, 0x05, 0x0a, 0x05], 0x1005012c],
    ["CLEAR UNIT ALTERNATE の引数が 0 でない", [ESC, COMMAND.CLEAR_UNIT_ALTERNATE, 0x80], 0x10030101],
    ["WSF D9/72 のフラグに 0x80", [ESC, WSF, 0x00, 0x06, 0xd9, 0x72, 0x80, 0x00], 0x10050112]
  ] as const)("%s", (_name, head, sense) => {
    const { r, a } = apply([...head]);
    expect(r.senseCode).toBe(sense);
    expect(a, "後ろの WTD が書かれていない").toBe(" ");
    expect(r.readRequested, "後ろの READ が効いていない").toBe(false);
  });
});
