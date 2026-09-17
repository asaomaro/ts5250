import { describe, it, expect } from "vitest";
import { applyDataStream } from "../src/protocol/wtd-applier.js";
import { ScreenBuffer } from "../src/screen/buffer.js";
import { Session5250 } from "../src/session/session.js";
import { ReplayTransport } from "../src/trace/replay.js";
import { bytesToHex, type TraceEntry } from "../src/trace/trace.js";
import { buildRecord } from "../src/protocol/gds.js";
import { codecForCcsid } from "@ts5250/ebcdic/codec";
import { ESC, COMMAND, ORDER, OPCODE } from "../src/protocol/constants.js";
import { IAC, CMD } from "../src/telnet/constants.js";

/**
 * **IC/MC は WTD ごとに確定し、SOH・CLEAR UNIT・CLEAR FORMAT TABLE で捨てる**（ACS 準拠）。
 *
 * ACS（`DS5250`）は IC/MC を保留値（`WTD_IC_addr`）に溜め、WTD を 1 つ処理し終えた時点
 * （`preprocessWCC2`）でカーソルを確定する。保留値は SOH の `processClearFMT()` で捨てられる。
 * 以前はレコード全体で「最後に見た IC」を採っていたため、PA0100R（出荷予測売上係数入力）の
 * 「ヘッダ WTD（IC(2,10)）→ 明細 WTD（SOH あり・IC なし）」で、既に保護化された年月度 (2,10) に
 * カーソルが残った（ACS は先頭入力欄 (3,23) へ落ちる。`work/pa0100j-cursor/` の実測）。
 *
 * **WRITE ERROR CODE を含むレコードでは、操作員が置いた位置から動かさない**（ACS 実測:
 * 明細から PageUp して「前ページはありません。」が出ても、カーソルはその場に留まる）。
 */
const codec = codecForCcsid(37);

/** SOH（本体 7 バイト。エラー行 0＝申告なし） */
const SOH = [ORDER.SOH, 7, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
const WTD = [ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00];
const READ = [ESC, COMMAND.READ_MDT_FIELDS, 0x00, 0x00];
const IC = (row: number, col: number): number[] => [ORDER.IC, row, col];
/** 保護欄（年月度ヘッダ）→ (2,10) から 6 桁 */
const HEADER_FIELD = [ORDER.SBA, 2, 9, ORDER.SF, 0x60, 0x00, 0x20, 0x00, 6];
/** 入力欄（明細）→ (3,23) から 5 桁 */
const DETAIL_FIELD = [ORDER.SBA, 3, 22, ORDER.SF, 0x40, 0x00, 0x20, 0x00, 5];
/** WRITE ERROR CODE（実機と同じく IC ＋ 属性 ＋ 本文） */
const WEC = [ESC, COMMAND.WRITE_ERROR_CODE, ORDER.IC, 2, 10, 0x22, ...codec.encode("NO PREVIOUS PAGE").bytes];

function apply(stream: number[], buf = new ScreenBuffer()): { buf: ScreenBuffer; cursorSet: boolean } {
  const result = applyDataStream(Uint8Array.from(stream), buf, codec, () => {});
  return { buf, cursorSet: result.cursorSet };
}

const at = (buf: ScreenBuffer): { row: number; col: number } => buf.rowColOf(buf.cursorAddr);

describe("IC/MC は WTD ごとに確定する（applyDataStream）", () => {
  it("IC 付きのヘッダ WTD の後に「SOH あり・IC なし」の WTD が続くと、ホストは位置を指していない", () => {
    const { cursorSet } = apply([
      ...WTD, ...SOH, ...HEADER_FIELD, ...IC(2, 10),
      ...WTD, ...SOH, ...DETAIL_FIELD,
      ...READ
    ]);
    expect(cursorSet).toBe(false);
  });

  it("SOH の後に置かれた IC は有効", () => {
    const { buf, cursorSet } = apply([
      ...WTD, ...SOH, ...HEADER_FIELD, ...IC(2, 10),
      ...WTD, ...SOH, ...DETAIL_FIELD, ...IC(3, 23),
      ...READ
    ]);
    expect(cursorSet).toBe(true);
    expect(at(buf)).toEqual({ row: 3, col: 23 });
  });

  it("SOH の無い後続 WTD では保留値が生きている（ACS の `WTD_IC_addr` は SOH まで残る）", () => {
    const { buf, cursorSet } = apply([
      ...WTD, ...SOH, ...HEADER_FIELD, ...IC(2, 10),
      ...WTD, ORDER.SBA, 10, 1, ...codec.encode("TEXT").bytes,
      ...READ
    ]);
    expect(cursorSet).toBe(true);
    expect(at(buf)).toEqual({ row: 2, col: 10 });
  });

  it("同じ WTD の中でも、IC の後に SOH が来たら IC は捨てる", () => {
    const { cursorSet } = apply([...WTD, ...IC(2, 10), ...SOH, ...DETAIL_FIELD, ...READ]);
    expect(cursorSet).toBe(false);
  });

  it.each([
    ["CLEAR UNIT", [ESC, COMMAND.CLEAR_UNIT]],
    ["CLEAR FORMAT TABLE", [ESC, COMMAND.CLEAR_FORMAT_TABLE]]
  ])("%s でも保留値を捨てる", (_name, clear) => {
    const { cursorSet } = apply([
      ...WTD, ...HEADER_FIELD, ...IC(2, 10),
      ...clear,
      ...WTD, ...DETAIL_FIELD,
      ...READ
    ]);
    expect(cursorSet).toBe(false);
  });

  it("MC も IC と同じく保留して WTD の終わりで確定する", () => {
    const { buf, cursorSet } = apply([...WTD, ...SOH, ...DETAIL_FIELD, ORDER.MC, 3, 25, ...READ]);
    expect(cursorSet).toBe(true);
    expect(at(buf)).toEqual({ row: 3, col: 25 });
  });
});

describe("WRITE ERROR CODE を含むレコードではカーソルを動かさない", () => {
  it.each([
    ["0x21", [...WEC]],
    ["0x22（窓）", [ESC, COMMAND.WRITE_ERROR_CODE_WINDOW, 0x02, 0x4f, ...WEC.slice(2)]]
  ])("WEC %s: 明細を描き直す WTD と IC があっても、受信前の位置に留まる", (_name, wec) => {
    const buf = new ScreenBuffer();
    apply([...WTD, ...SOH, ...HEADER_FIELD, ...DETAIL_FIELD, ...IC(3, 23), ...READ], buf);
    buf.cursorAddr = buf.addrOf(3, 25); // 操作員が明細の途中へ移した
    const { cursorSet } = apply([...WTD, ...SOH, ...DETAIL_FIELD, ...wec, ...READ], buf);
    expect(cursorSet).toBe(true); // 「指定あり」扱い＝呼び出し側が先頭入力欄へ寄せない
    expect(at(buf)).toEqual({ row: 3, col: 25 });
    expect(buf.systemMessage).toBe("NO PREVIOUS PAGE");
  });
});

/** Telnet の EOR 枠に入れた受信エントリ */
function rx(stream: number[]): TraceEntry {
  const framed: number[] = [];
  for (const b of buildRecord(OPCODE.PUT_GET, Uint8Array.from(stream))) {
    framed.push(b);
    if (b === IAC) framed.push(IAC);
  }
  framed.push(IAC, CMD.EOR);
  return { ts: "t", dir: "rx", hex: bytesToHex(Uint8Array.from(framed)) };
}

/**
 * 1 画面目を出し、`cursor` から Enter（PageUp 相当）を送って 2 画面目を受けたあとのカーソル。
 * `tx` の印を挟むのは、`ReplayTransport` が**こちらが送るまで次の rx を流さない**ため。
 */
async function play(second: number[], cursor: { row: number; col: number }): Promise<{ row: number; col: number }> {
  const first = [...WTD, ...SOH, ...HEADER_FIELD, ...DETAIL_FIELD, ...IC(2, 10), ...READ];
  const transport = new ReplayTransport([rx(first), { ts: "t", dir: "tx", masked: true, len: 0 }, rx(second)]);
  const session = await Session5250.connect({ transport, id: "t" });
  await session.sendAid("Enter", { timeoutMs: 2000, cursor });
  return session.snapshot().cursor;
}

describe("セッション: PA0100R 型の応答で先頭入力欄へ落ちる", () => {
  it("ヘッダ WTD の IC(2,10) に引きずられず、明細の先頭入力欄 (3,23) に置く", async () => {
    const second = [
      ...WTD, ...SOH, ...HEADER_FIELD, ...IC(2, 10),
      ...WTD, ...SOH, ...DETAIL_FIELD,
      ...READ
    ];
    expect(await play(second, { row: 3, col: 23 })).toEqual({ row: 3, col: 23 });
  });

  it("エラー通知（WEC）の応答では、送信前にカーソルを置いた桁に留まる", async () => {
    const second = [...WTD, ...SOH, ...HEADER_FIELD, ...DETAIL_FIELD, ...WEC, ...READ];
    expect(await play(second, { row: 3, col: 25 })).toEqual({ row: 3, col: 25 });
  });
});
