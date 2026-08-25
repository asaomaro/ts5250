import { describe, it, expect } from "vitest";
import {
  buildReadInputFieldsResponse,
  buildReadMdtResponse
} from "../src/protocol/read-response.js";
import { applyDataStream } from "../src/protocol/wtd-applier.js";
import { parseRecord } from "../src/protocol/gds.js";
import { ScreenBuffer } from "../src/screen/buffer.js";
import { codecForCcsid } from "@ts5250/ebcdic/codec";
import { AID, ORDER, OPCODE, FFW, COMMAND, ESC } from "../src/protocol/constants.js";
import { Session5250 } from "../src/session/session.js";
import { ReplayTransport } from "../src/trace/replay.js";
import { parseTraceJsonl, bytesToHex, type TraceEntry } from "../src/trace/trace.js";
import { buildRecord } from "../src/protocol/gds.js";
import { ByteWriter } from "../src/protocol/bytes.js";
import { IAC, CMD } from "../src/telnet/constants.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * **READ INPUT FIELDS（0x42）**。
 *
 * `0x52`（READ MDT FIELDS）と**同じ枝で扱ってはいけない**。原典 2 実装が揃って
 * 別扱いにしている（GNU tn5250 `session.c` の `tn5250_session_send_field` は
 * `CMD_READ_INPUT_FIELDS` を `CMD_READ_IMMEDIATE` と同じ枝に置き、`CMD_READ_MDT_FIELDS`
 * とは分けている／tn5250j `ScreenFields.readFormatTable` も `setSBA` を通さない）:
 *
 * | | 0x52 / 0x82 / 0x83 | **0x42 / 0x72** |
 * |---|---|---|
 * | 欄の位置 | `SBA(行,桁)` を前置き | **付けない**（位置で区切る） |
 * | 送る欄 | MDT の立った欄だけ | **全ての欄**（門番は画面単位の MDT） |
 * | 長さ | 末尾の空白を落とす | **欄長ぶんそのまま** |
 *
 * ## 実機で確かめた（2026-08-25・実機 / IBM i 7.3）
 *
 * 欄長 **10 / 6 / 8** の試験画面を `QsnPutOutCmd(0x11, …)` で描かせ、
 * 欄1 に `"ABC"`・欄2 は未入力・欄3 に `"12345678"` を打って `0x52` と `0x42` を
 * 並べた（`scripts/host-src/dscmd.c` の `READINP`）。
 *
 * ```
 * [0x52 対照] QsnRtvFldCnt=2  fld[1] (5,10) len=3 "ABC"  fld[2] (9,10) len=8 "12345678"
 * [0x42 生]   QsnRtvFldCnt → CPFA32E（この読み取りでは欄へ分解されない）
 *             QsnRtvFldDta = 11050ac1c2c311090af1f2f3f4f5f6f7f8（17 バイト）
 *             欄長 10/6/8 で切ると
 *               切片1 11050ac1c2c311090af1   ← 期待は "ABC" ＋ 空白 7
 *               切片2 f2f3f4f5f6f7           ← 期待は 空白 6
 *               切片3 f8 ＋ 7 バイト足りない  ← 期待は "12345678"
 * ```
 *
 * **ホストは欄へ分解しないので、応用プログラムは欄長で切るしかない。**
 * SBA 付きで返すと切片が丸ごとずれる＝**打った値と一致しない**。
 *
 * ⚠ `QsnReadInp`（API 経由）は `CPFA306`（この装置ではサポートされない）で出せない。
 * 上は `QsnPutInpCmd(0x42, …)` で生のコマンドとして出したもの。
 */

const codec = codecForCcsid(37);

/** 実機の試験画面と同じ形: 欄長 10 / 6 / 8 */
function makeBuffer(): ScreenBuffer {
  const b = new ScreenBuffer();
  b.setAttr(b.addrOf(5, 9), 0x20);
  b.addField(b.addrOf(5, 10), 10, FFW.ID_VALUE, 0x20);
  b.setAttr(b.addrOf(7, 9), 0x20);
  b.addField(b.addrOf(7, 10), 6, FFW.ID_VALUE, 0x20);
  b.setAttr(b.addrOf(9, 9), 0x20);
  b.addField(b.addrOf(9, 10), 8, FFW.ID_VALUE, 0x20);
  return b;
}

const dataOf = (record: Uint8Array): number[] => [...parseRecord(record).data];

describe("buildReadInputFieldsResponse（0x42）", () => {
  it("**実機で採った並びを再現する**——SBA 無し・全欄・欄長ぶんそのまま", () => {
    const b = makeBuffer();
    b.setFieldValue(b.fieldByIndex(1), "ABC");
    b.setFieldValue(b.fieldByIndex(3), "12345678");
    const d = dataOf(buildReadInputFieldsResponse(b, codec, AID.ENTER, { row: 5, col: 10 }).record);

    expect(d.slice(0, 3)).toEqual([5, 10, AID.ENTER]);
    // 欄長で切ると打った値そのもの（10 / 6 / 8）
    expect(d.slice(3, 13)).toEqual([...codec.encode("ABC       ").bytes]);
    expect(d.slice(13, 19)).toEqual([...codec.encode("      ").bytes]);
    expect(d.slice(19, 27)).toEqual([...codec.encode("12345678").bytes]);
    expect(d).toHaveLength(3 + 24);
  });

  it("SBA を 1 バイトも出さない", () => {
    const b = makeBuffer();
    b.setFieldValue(b.fieldByIndex(1), "ABC");
    const d = dataOf(buildReadInputFieldsResponse(b, codec, AID.ENTER).record);
    expect(d.filter((x, i) => x === ORDER.SBA && i >= 3)).toEqual([]);
  });

  it("**0x52 とは別物**——同じ画面で並びが違う（実機の対照実験そのもの）", () => {
    const b = makeBuffer();
    b.setFieldValue(b.fieldByIndex(1), "ABC");
    b.setFieldValue(b.fieldByIndex(3), "12345678");
    const mdt = dataOf(buildReadMdtResponse(b, codec, AID.ENTER, { row: 5, col: 10 }).record);
    // 0x52 は SBA 付き・MDT の立った欄だけ・末尾を落とす
    expect(mdt.slice(3, 6)).toEqual([ORDER.SBA, 5, 10]);
    expect(mdt).toHaveLength(3 + 3 + 3 + 3 + 8);
  });

  it("**AID は利用者が押した鍵**（0x72 と違い 0 ではない）", () => {
    const b = makeBuffer();
    b.setFieldValue(b.fieldByIndex(1), "X");
    const d = dataOf(buildReadInputFieldsResponse(b, codec, AID.F3, { row: 1, col: 1 }).record);
    expect(d[2]).toBe(AID.F3);
  });

  it("どの欄も変更されていなければ欄を 1 つも送らない（画面単位の MDT が門番）", () => {
    const b = makeBuffer();
    const d = dataOf(buildReadInputFieldsResponse(b, codec, AID.ENTER, { row: 2, col: 3 }).record);
    expect(d).toEqual([2, 3, AID.ENTER]);
  });

  it("レコードの opcode は PUT_GET", () => {
    const b = makeBuffer();
    b.setFieldValue(b.fieldByIndex(1), "X");
    expect(parseRecord(buildReadInputFieldsResponse(b, codec, AID.ENTER).record).opcode).toBe(
      OPCODE.PUT_GET
    );
  });

  it("**符号付き数値は符号桁を送らない**（欄長 − 1。加工は 0x52 と同じ）", () => {
    const b = new ScreenBuffer();
    b.setAttr(b.addrOf(4, 9), 0x20);
    // 桁数 3 ＋ 符号桁 1 ＝ ワイヤ上 4
    b.addField(b.addrOf(4, 10), 4, FFW.ID_VALUE | FFW.SHIFT_SIGNED_NUMERIC, 0x20);
    b.setFieldValue(b.fieldByIndex(1), " 12-");
    const d = dataOf(buildReadInputFieldsResponse(b, codec, AID.ENTER, { row: 1, col: 1 }).record);
    // 3 バイト（符号桁は落ちる）。最終桁 "2" のゾーンが 0xD になる
    expect(d.slice(3)).toEqual([0x40, 0xf1, 0xd2]);
  });
});

describe("データストリームからの受け口（0x42）", () => {
  const stream = (...bytes: number[]): Uint8Array => Uint8Array.from(bytes);

  it("**入力待ちに入る**（0x72 と違い利用者の AID を待つ）", () => {
    const b = makeBuffer();
    const r = applyDataStream(
      stream(ESC, COMMAND.READ_INPUT_FIELDS, 0x00, 0x00),
      b,
      codec,
      () => undefined
    );
    expect(r.readRequested).toBe(true);
    expect(r.unlockKeyboard).toBe(true);
    // **どの Read で待つかを残す**（次の AID で返す形式が変わる）
    expect(r.readCommand).toBe(COMMAND.READ_INPUT_FIELDS);
  });

  it("0x52 は `readCommand` に 0x52 が残る", () => {
    const b = makeBuffer();
    const r = applyDataStream(
      stream(ESC, COMMAND.READ_MDT_FIELDS, 0x00, 0x00),
      b,
      codec,
      () => undefined
    );
    expect(r.readCommand).toBe(COMMAND.READ_MDT_FIELDS);
  });

  it("Read を含まないレコードでは `readCommand` を触らない", () => {
    const b = makeBuffer();
    const r = applyDataStream(stream(ESC, COMMAND.CLEAR_UNIT), b, codec, () => undefined);
    expect(r.readCommand).toBeUndefined();
  });
});

/**
 * **セッションが形式を切り替えるか。** 応答を作れても、セッションが 0x52 用の
 * ビルダーを呼んでいたら意味がない（この作業で見つかった不具合そのもの）。
 */
describe("セッションは 0x42 で待たされたら平坦形式で返す", () => {
  const here = dirname(fileURLToPath(import.meta.url));

  /** レコードを telnet 枠（IAC エスケープ＋IAC EOR）に包んで rx trace エントリにする */
  function rxRecord(record: Uint8Array): TraceEntry {
    const framed: number[] = [];
    for (const b of record) {
      framed.push(b);
      if (b === IAC) framed.push(IAC);
    }
    framed.push(IAC, CMD.EOR);
    return { ts: "t", dir: "rx", hex: bytesToHex(Uint8Array.from(framed)) };
  }

  /** 欄長 6 の入力欄を 1 つ描いて、指定の READ で待たせるレコード */
  function screenThen(readCmd: number): Uint8Array {
    const w = new ByteWriter();
    w.u8(ESC).u8(COMMAND.CLEAR_UNIT);
    w.u8(ESC).u8(COMMAND.WRITE_TO_DISPLAY).u8(0x00).u8(0x00);
    w.u8(ORDER.SBA).u8(5).u8(9);
    w.u8(ORDER.SF).u16(FFW.ID_VALUE).u8(0x20).u16(6); // (5,9) 属性 → (5,10) から 6 桁
    w.u8(ORDER.IC).u8(5).u8(10);
    w.u8(ESC).u8(readCmd).u8(0x00).u8(0x00);
    return buildRecord(OPCODE.PUT_GET, w.toUint8Array());
  }

  async function run(readCmd: number): Promise<number[]> {
    const entries: TraceEntry[] = [
      ...parseTraceJsonl(readFileSync(join(here, "fixtures", "pub400-signon.jsonl"), "utf8")),
      { ts: "t", dir: "tx", masked: true, len: 0 },
      rxRecord(screenThen(readCmd))
    ];
    const transport = new ReplayTransport(entries);
    const session = await Session5250.connect({ transport, id: "read-cmd" });
    // サインオン画面 → 試験画面へ
    await session.sendAid("Enter", { timeoutMs: 500 });
    const f = session.snapshot().fields.find((x) => !x.protected);
    session.setField({ index: f!.index }, "AB");
    void session.sendAid("Enter", { cursor: { row: 5, col: 10 }, timeoutMs: 30 });
    const sent = transport.sentChunks.at(-1) as Uint8Array;
    const raw = [...sent].slice(0, -2); // 末尾の IAC EOR を外す
    return [...parseRecord(Uint8Array.from(raw)).data];
  }

  it("0x42 → **SBA 無し・欄長 6 ぶん**（AB ＋ 空白 4）", async () => {
    const d = await run(COMMAND.READ_INPUT_FIELDS);
    expect(d.slice(0, 3)).toEqual([5, 10, AID.ENTER]);
    expect(d.slice(3)).toEqual([...codec.encode("AB    ").bytes]);
  });

  it("0x52 → 従来どおり **SBA 付き・末尾を落とす**", async () => {
    const d = await run(COMMAND.READ_MDT_FIELDS);
    expect(d.slice(0, 3)).toEqual([5, 10, AID.ENTER]);
    expect(d.slice(3)).toEqual([ORDER.SBA, 5, 10, ...codec.encode("AB").bytes]);
  });
});
