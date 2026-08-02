import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validateFieldContent } from "../src/screen/field-validate.js";
import { codecForCcsid } from "@ts5250/ebcdic/codec";
import { ESC, COMMAND, ORDER, OPCODE, FFW } from "../src/protocol/constants.js";
import { Session5250 } from "../src/session/session.js";
import { ReplayTransport } from "../src/trace/replay.js";
import { parseTraceJsonl, bytesToHex, type TraceEntry } from "../src/trace/trace.js";
import { buildRecord } from "../src/protocol/gds.js";
import { ByteWriter } from "../src/protocol/bytes.js";
import { IAC, CMD } from "../src/telnet/constants.js";
import type { InternalField } from "../src/screen/buffer.js";

const codec = codecForCcsid(37);
const fieldWith = (ffw: number, length = 12): InternalField =>
  ({ ffw, length, startAddr: 0, attrByte: 0x20, mdt: false }) as unknown as InternalField;

/**
 * **ホストが欄に書いた文字は送り返せる。**
 *
 * DDS の `EDTCDE` / `EDTWRD` は**用途 B（入出力両用）でも書ける**（実機で実測）。
 * そのとき編集文字は EDTMSK のように分解されず、**入力欄の中に入って**来る:
 *
 * ```
 * in#1 r3 c22 len=8 numeric=true value="     .00"   FFW=0x4300 shift=num-only
 * ```
 *
 * `EDTCDE(A)` 系は負値を `CR` で表し、`EDTWRD` の定数文字は任意（`$` `*` `/` `¥`）。
 * 数値欄の許容集合 `/^[0-9.,+-]*$/` で弾くと、**ホスト自身が書いた値を送り返せず
 * 画面ごと送信できなくなる**。
 *
 * かといって許容集合を一律に広げるとただの誤入力も通る。
 * → **その欄の現在値に含まれる文字だけを通す。**
 */
describe("現在値にある文字は型検証で弾かない", () => {
  const numeric = fieldWith(0x4000 | FFW.SHIFT_NUMERIC_ONLY);

  it("編集語つきの欄: ホストが書いた `$` `*` を含む値を送り返せる", () => {
    const current = "$***1,234.56";
    expect(() => validateFieldContent("$***1,234.57", numeric, codec, current)).not.toThrow();
  });

  it("`CR`（EDTCDE(A) 系の負値表現）も送り返せる", () => {
    expect(() => validateFieldContent("1,234.56CR", numeric, codec, "1,234.56CR")).not.toThrow();
  });

  it("日付の編集語（`/`）も送り返せる", () => {
    expect(() => validateFieldContent("12/31/26", numeric, codec, "01/01/26")).not.toThrow();
  });

  it("**現在値に無い文字は従来どおり弾く**（空振り防止の要）", () => {
    // `$` は現在値に無い＝ホストが書いたものではない＝ただの誤入力
    expect(() => validateFieldContent("12$4", numeric, codec, "1234")).toThrow(/numeric field/);
  });

  it("現在値の一部だけ一致していても、無い文字は弾く", () => {
    // `,` は現在値にあるが `%` は無い
    expect(() => validateFieldContent("1,2%4", numeric, codec, "1,234")).toThrow(/numeric field/);
  });

  it("現在値を渡さない呼び出しは従来どおり（回帰）", () => {
    expect(() => validateFieldContent("1,234.56", numeric, codec)).not.toThrow();
    expect(() => validateFieldContent("12$4", numeric, codec)).toThrow(/numeric field/);
  });

  it("digits-only 欄でも同じ規則（現在値にある文字だけ通す）", () => {
    const digits = fieldWith(0x4000 | FFW.SHIFT_DIGITS_ONLY);
    expect(() => validateFieldContent("1.23", digits, codec, "9.99")).not.toThrow();
    expect(() => validateFieldContent("1.23", digits, codec, "999")).toThrow(/digits only/);
  });

  it("英字専用欄でも同じ規則", () => {
    const alpha = fieldWith(0x4000 | FFW.SHIFT_ALPHA_ONLY);
    expect(() => validateFieldContent("AB1", alpha, codec, "XY1")).not.toThrow();
    expect(() => validateFieldContent("AB1", alpha, codec, "XYZ")).toThrow(/alphabetic-only/);
  });

  it("**コードページ検証は現在値で緩めない**（別の理由の検証）", () => {
    // SBCS の CCSID 37 は全角を表現できない。現在値に何があっても送れないものは送れない
    const f = fieldWith(0x4000);
    expect(() => validateFieldContent("あ", f, codec, "あ")).toThrow(/not representable/);
  });

  it("**DBCS 種別の検証も現在値で緩めない**", () => {
    const pure = { ...fieldWith(0x4000), dbcsType: "pure" } as unknown as InternalField;
    const dbcs = codecForCcsid(939);
    expect(() => validateFieldContent("AB", pure, dbcs, "AB")).toThrow(/DBCS-only/);
  });
});

// ---------------------------------------------------------------------------
// 配線（session が現在値を渡しているか）
// ---------------------------------------------------------------------------

/**
 * **`session.setField` が「その欄の現在値」を検証へ渡していること**を、
 * 実際のセッション越しに確かめる。
 *
 * 純関数のテスト（上）だけでは、**渡し忘れても誰も気づかない**（空振り検証で判明）。
 * ここが繋がっていないと、ホストが書いた編集文字を弾く元の不具合がそのまま残る。
 */
describe("session.setField が現在値を検証へ渡す", () => {
  /** ホストが編集文字入りの値を書いた入力欄を持つ画面 */
  function editedFieldRecord(): Uint8Array {
    const w = new ByteWriter();
    w.u8(ESC).u8(COMMAND.CLEAR_UNIT);
    w.u8(ESC).u8(COMMAND.WRITE_TO_DISPLAY).u8(0x00).u8(0x18); // CC2: UNLOCK
    // 欄 1: num-only・12 桁。ホストが `$***1,234.56` と書いてある（EDTWRD 相当）
    w.u8(ORDER.SBA).u8(5).u8(9);
    w.u8(ORDER.SF).u16(FFW.ID_VALUE | FFW.SHIFT_NUMERIC_ONLY).u8(0x20).u16(12);
    w.bytes(Uint8Array.from([...codec.encode("$***1,234.56").bytes]));
    // 欄 2: num-only・4 桁。素の数字だけ（対照）
    w.u8(ORDER.SBA).u8(7).u8(9);
    w.u8(ORDER.SF).u16(FFW.ID_VALUE | FFW.SHIFT_NUMERIC_ONLY).u8(0x20).u16(4);
    w.bytes(Uint8Array.from([...codec.encode("1234").bytes]));
    w.u8(ESC).u8(COMMAND.READ_MDT_FIELDS).u8(0x00).u8(0x00);
    return buildRecord(OPCODE.PUT_GET, w.toUint8Array());
  }

  async function connect() {
    const here = dirname(fileURLToPath(import.meta.url));
    const signon = parseTraceJsonl(readFileSync(join(here, "fixtures", "pub400-signon.jsonl"), "utf8"));
    const framed: number[] = [];
    for (const b of editedFieldRecord()) {
      framed.push(b);
      if (b === IAC) framed.push(IAC);
    }
    framed.push(IAC, CMD.EOR);
    const entries: TraceEntry[] = [
      ...signon,
      { ts: "t", dir: "tx", masked: true, len: 0 },
      { ts: "t", dir: "rx", hex: bytesToHex(Uint8Array.from(framed)) }
    ];
    const session = await Session5250.connect({ transport: new ReplayTransport(entries), id: "edt" });
    // ReplayTransport は**送信のたびに次の受信を返す**ので、サインオン画面から 1 手進めて
    // 上で組み立てた画面を受け取る（`session.test.ts` の scenario と同じ流れ）
    await session.sendAid("Enter");
    return session;
  }

  it("ホストが書いた編集文字を含む値を送り返せる", async () => {
    const session = await connect();
    const f = session.snapshot().fields.find((x) => !x.protected && x.length === 12)!;
    expect(f.value, "前提: ホストが編集文字を書いている").toContain("$");
    expect(() => session.setField({ index: f.index }, "$***1,234.57")).not.toThrow();
  });

  it("**素の数字欄では従来どおり弾く**（配線が緩めすぎになっていない）", async () => {
    const session = await connect();
    const f = session.snapshot().fields.find((x) => !x.protected && x.length === 4)!;
    expect(() => session.setField({ index: f.index }, "12$4")).toThrow(/numeric field/);
  });
});
