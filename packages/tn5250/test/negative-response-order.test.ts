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

/**
 * **WSF の応答と、同じレコードの READ SCREEN 系の応答は全部送る**（`20260921-negative-responses` の節目 10 の独立点検 A-S1。
 * 以前は WSF の応答だけで戻る・READ SCREEN 系は 1 つだけ送って戻るので、片方が落ちてホストが待ち続けた）。
 * 並びは SAVE → WSF → READ SCREEN EXTENDED → READ IMMEDIATE → READ MDT IMMEDIATE ALT → READ SCREEN で固定（コマンド順は追わない）。
 * 否定応答は最後。応答だけのレコードは画面イベントを出さないが、**同じレコードで画面を書いていたら出す**
 */
describe("応答が複数あるレコード", () => {
  const QUERY_SF = [ESC, WSF, 0x00, 0x05, 0xd9, 0x70, 0x00];
  const READ_SCREEN = [ESC, COMMAND.READ_SCREEN];
  const READ_IMM = [ESC, COMMAND.READ_IMMEDIATE];
  const kinds = async (data: number[]) => (await run(data)).sent.map((x) => (x.startsWith("NEG") ? x : x === QUERY_REPLY ? "query" : x.slice(0, 6)));

  it("**WSF の Query と READ SCREEN の両方に応答する**（以前は Query だけで、画面の応答が落ちた）", async () => {
    const k = await kinds([...QUERY_SF, ...READ_SCREEN]);
    expect(k[0]).toBe("query");
    expect(k.length).toBe(2);
    expect(k[1]).not.toBe("query");
  });

  it("**READ SCREEN と READ IMMEDIATE も片方に絞らない**（以前は READ IMMEDIATE だけ送った）", async () => {
    expect((await run([...READ_SCREEN, ...READ_IMM])).sent).toHaveLength(2);
  });

  it("**READ MDT IMMEDIATE ALT・READ SCREEN EXTENDED も WSF の応答と一緒に返す**（片方に絞らない）", async () => {
    for (const cmd of [[ESC, COMMAND.READ_IMMEDIATE_ALT], [ESC, COMMAND.READ_SCREEN_EXTENDED]]) {
      const k = await kinds([...QUERY_SF, ...cmd]);
      expect(k, `cmd ${cmd[1]!.toString(16)}`).toHaveLength(2);
      expect(k[0]).toBe("query");
      expect(k[1]).not.toBe("query");
    }
  });

  it("**READ 系だけのレコードは応答を 1 本返し、画面イベントを出さない**（READ IMMEDIATE・READ MDT IMMEDIATE ALT・READ SCREEN EXTENDED）", async () => {
    for (const cmd of [READ_IMM, [ESC, COMMAND.READ_IMMEDIATE_ALT], [ESC, COMMAND.READ_SCREEN_EXTENDED]]) {
      const r = await run(cmd);
      expect(r.sent, `cmd ${cmd[1]!.toString(16)}`).toHaveLength(1);
      expect(r.screens, `cmd ${cmd[1]!.toString(16)}`).toEqual([]);
    }
  });

  it("否定応答は応答の最後（WSF ＋ READ SCREEN ＋ ゴミ）", async () => {
    const k = await kinds([...QUERY_SF, ...READ_SCREEN, 0x99]);
    expect(k.at(-1)).toBe("NEG 10050121");
    expect(k.length).toBe(3);
  });

  it("**READ 系の応答の後ろでも否定応答を送る**（READ SCREEN・READ IMMEDIATE・READ SCREEN EXTENDED の各経路）", async () => {
    for (const cmd of [READ_SCREEN, READ_IMM, [ESC, COMMAND.READ_SCREEN_EXTENDED]]) {
      const k = await kinds([...cmd, 0x99]);
      expect(k.at(-1), `cmd ${cmd[1]!.toString(16)}`).toBe("NEG 10050121");
    }
  });

  it("**応答だけのレコードは画面イベントを出さないが、同じレコードで画面を書いていたら出す**（WTD ＋ WSF）", async () => {
    const wtd = [ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00, ORDER.SBA, 1, 1, 0xc1];
    const withWrite = await run([...wtd, ...QUERY_SF]);
    expect(withWrite.session.snapshot().cells[0]![0]!.char, "画面は書かれる").toBe("A");
    expect(withWrite.screens.length, "書いたので画面イベントを出す").toBe(1);
    expect((await run(QUERY_SF)).screens, "応答だけなら出さない").toEqual([]);
    expect((await run(READ_SCREEN)).screens, "READ SCREEN だけでも出さない").toEqual([]);
  });
});

/**
 * **オペコードと WSF の境界**（節目 10 の独立点検 A-S2 で、選んだ変異の外に生き残った箇所を固定する）
 */
describe("オペコードごとの読み方の境界", () => {
  const WTD_A = [ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00, ORDER.SBA, 1, 1, 0xc1];
  const first = (r: Awaited<ReturnType<typeof run>>) => r.session.snapshot().cells[0]![0]!.char;

  it("CANCEL INVITE のデータは読まない（ESC でなくても否定応答にしない。応答は 12 バイトの確認だけ）", async () => {
    const r = await run([0x99, 0x01], OPCODE.CANCEL_INVITE);
    expect(r.sent.every((x) => !x.startsWith("NEG"))).toBe(true);
  });

  it("メッセージ灯 OFF のデータも読まない", async () => {
    const r = await run(WTD_A, OPCODE.MESSAGE_LIGHT_OFF);
    expect(first(r)).toBe(" ");
    expect(r.sent).toEqual([]);
  });

  it("RESTORE SCREEN も最初の ESC まで読み飛ばす（先頭のゴミで否定応答にしない・後ろの WTD は効く）", async () => {
    const r = await run([0x00, 0x11, ...WTD_A], OPCODE.RESTORE_SCREEN);
    expect(r.sent).toEqual([]);
    expect(first(r)).toBe("A");
  });

  it("OUTPUT ONLY・RESTORE で ESC が 1 つも無ければ何も読まない（否定応答にしない）", async () => {
    for (const op of [OPCODE.OUTPUT_ONLY, OPCODE.RESTORE_SCREEN]) {
      expect((await run([0x00, 0x11, 0x22], op)).sent, `opcode ${op}`).toEqual([]);
    }
  });

  it("**知らないオペコードの境界**: 0x11 までは読む・0x12 からは否定応答（0x10・0x11 は ACS が知っている）", async () => {
    for (const op of [0x0d, 0x10, 0x11]) expect((await run(WTD_A, op)).sent.some((x) => x.startsWith("NEG")), `0x${op.toString(16)}`).toBe(false);
    for (const op of [0x12, 0x1f, 0x20]) expect((await run(WTD_A, op)).sent, `0x${op.toString(16)}`).toEqual(["NEG 10030101"]);
  });

  it("知らないオペコードでは画面イベントを出さない（読まずに戻る）", async () => {
    expect((await run(WTD_A, 0x20)).screens).toEqual([]);
  });

  it("**WSF の SF は D9 クラスだけを見る**（type 0x70 でも class が違えば Query に応答しない）", async () => {
    expect((await run([ESC, WSF, 0x00, 0x05, 0xd8, 0x70, 0x00])).sent).toEqual([]);
    expect((await run([ESC, WSF, 0x00, 0x06, 0xd8, 0x72, 0x40, 0x00])).sent).toEqual([]);
  });

  it("**WSF の最短は 4 バイト**: 4 バイトあれば読む（長さ・class・type）、3 バイトなら否定応答", async () => {
    expect((await run([ESC, WSF, 0x00, 0x04, 0xd8, 0x70])).sent, "4 バイト（class が違う SF）は何もしない").toEqual([]);
    expect((await run([ESC, WSF, 0x00, 0x04, 0xd8])).sent, "3 バイトは足りない").toEqual(["NEG 10050121"]);
  });
});
