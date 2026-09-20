import { describe, it, expect } from "vitest";
import { Session5250 } from "../src/session/session.js";
import { ReplayTransport } from "../src/trace/replay.js";
import { bytesToHex, type TraceEntry } from "../src/trace/trace.js";
import { buildRecord } from "../src/protocol/gds.js";
import { ByteWriter } from "../src/protocol/bytes.js";
import { ESC, COMMAND, ORDER, OPCODE, FFW } from "../src/protocol/constants.js";
import { IAC, CMD } from "../src/telnet/constants.js";

/**
 * **欄の位置が、呼び出し側から文言まで実際に繋がっていること**を固定する。
 *
 * `validateFieldContent` は位置を**任意引数**で受け取る（`field-validate.ts` の `at`）。
 * その単体テスト（`field-validate.test.ts`）は `at` を手で作って渡すので、
 * **本番の呼び出し側が渡しているか**は見ていない——`Session.setField` が
 * `this.buf.rowColOf(field.startAddr)` を落としても、単体テストは緑のまま通る
 * （`20260920-field-error-no-value` の cross 点検で実測。第 5 引数を削っても
 * tn5250 689 件・server 1441 件・web-ui 2111 件すべて緑だった）。
 *
 * **値を文言から外した以上、利用者が「どこを直せばよいか」を知る手掛かりは位置しか残っていない**
 * （同 requirements US1 / AC3）。だから配線そのものを見るテストが要る。
 */

function rx(record: Uint8Array): TraceEntry {
  const framed: number[] = [];
  for (const b of record) {
    framed.push(b);
    if (b === IAC) framed.push(IAC);
  }
  framed.push(IAC, CMD.EOR);
  return { ts: "t", dir: "rx", hex: bytesToHex(Uint8Array.from(framed)) };
}

/**
 * 数字しか入らない欄を 1 つだけ置いた画面。
 * SBA が指すのは**属性バイトの桁**なので、欄そのものは次の桁（25）から始まる。
 */
function digitsOnlyScreen(row: number, col: number): Uint8Array {
  const w = new ByteWriter();
  w.u8(ESC).u8(COMMAND.CLEAR_UNIT);
  w.u8(ESC).u8(COMMAND.WRITE_TO_DISPLAY).u8(0x00).u8(0x18);
  w.u8(ORDER.SBA).u8(row).u8(col - 1);
  w.u8(ORDER.SF).u16(FFW.ID_VALUE | FFW.SHIFT_DIGITS_ONLY).u8(0x20).u16(20);
  w.u8(ESC).u8(COMMAND.READ_MDT_FIELDS).u8(0x00).u8(0x00);
  return buildRecord(OPCODE.PUT_GET, w.toUint8Array());
}

async function sessionWithFieldAt(row: number, col: number): Promise<Session5250> {
  return Session5250.connect({
    transport: new ReplayTransport([rx(digitsOnlyScreen(row, col))]),
    id: "t"
  });
}

function messageOf(fn: () => void): string {
  try {
    fn();
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("例外が投げられていない（この検査は空振りしている）");
}

describe("setField の検証エラーには、その欄の実際の位置が入る", () => {
  it("index 指定: ホストが置いた桁がそのまま文言に出る", async () => {
    const session = await sessionWithFieldAt(5, 25);
    // 前提: 欄はホストの指定どおり (5,25) に在る（位置の出どころがここだと示す）
    expect(session.snapshot().fields?.[0]).toMatchObject({ row: 5, col: 25 });

    expect(messageOf(() => session.setField({ index: 1 }, "abc"))).toBe(
      "field at (5,25) accepts digits only"
    );
  });

  it("row/col 指定でも同じ位置が出る（解決経路が違っても文言は欄の実位置）", async () => {
    const session = await sessionWithFieldAt(12, 4);
    expect(messageOf(() => session.setField({ row: 12, col: 4 }, "abc"))).toBe(
      "field at (12,4) accepts digits only"
    );
  });

  it("**位置は固定文字列ではない**（欄が動けば文言も動く）", async () => {
    // 同じ検証・同じ欄種別でも、画面上の位置が変われば文言も変わる。
    // 定数を埋めただけの実装ならここで落ちる
    const s1 = await sessionWithFieldAt(5, 25);
    const s2 = await sessionWithFieldAt(7, 30);
    expect(messageOf(() => s1.setField({ index: 1 }, "abc"))).not.toBe(
      messageOf(() => s2.setField({ index: 1 }, "abc"))
    );
  });
});
