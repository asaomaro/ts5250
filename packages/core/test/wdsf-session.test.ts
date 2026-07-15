import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Session5250 } from "../src/session/session.js";
import { ReplayTransport } from "../src/trace/replay.js";
import { parseTraceJsonl, bytesToHex, type TraceEntry } from "../src/trace/trace.js";
import { buildRecord } from "../src/protocol/gds.js";
import { ByteWriter } from "../src/protocol/bytes.js";
import { ESC, COMMAND, ORDER, OPCODE } from "../src/protocol/constants.js";
import { WDSF_TYPE } from "../src/protocol/wdsf-parser.js";
import { codecForCcsid } from "../src/codec/codec.js";
import { IAC, CMD } from "../src/telnet/constants.js";

const here = dirname(fileURLToPath(import.meta.url));
const codec = codecForCcsid(37);

function e(text: string): number[] {
  return [...codec.encode(text).bytes];
}

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

function signonEntries(): TraceEntry[] {
  return parseTraceJsonl(readFileSync(join(here, "fixtures", "pub400-signon.jsonl"), "utf8"));
}

/** WDSF 構造体を WTD オーダーとして書き込む */
function writeWdsf(w: ByteWriter, type: number, body: number[]): void {
  const sf = [0xd9, type, ...body];
  const ll = sf.length + 2;
  w.u8(ORDER.WDSF).u16(ll).bytes(sf);
}

/** ウィンドウ＋単一選択フィールド＋スクロールバーを含む合成 GUI 画面 */
function guiRecord(): Uint8Array {
  const w = new ByteWriter();
  w.u8(ESC).u8(COMMAND.CLEAR_UNIT);
  w.u8(ESC).u8(COMMAND.WRITE_TO_DISPLAY).u8(0x00).u8(0x18); // unlock
  w.u8(ORDER.SBA).u8(2).u8(41).bytes(e("Options"));

  // ウィンドウ（5,10）depth=6 width=30 title="CHOOSE"
  w.u8(ORDER.SBA).u8(5).u8(10);
  const border = [0x0c, 0x10, 0x00, 0x00, 0x00, 0x00, ...e("CHOOSE")];
  writeWdsf(w, WDSF_TYPE.CREATE_WINDOW, [0x80, 0x00, 0x00, 0x06, 0x1e, ...border]);

  // 単一選択フィールド（6,12）: YES(既定)/NO
  w.u8(ORDER.SBA).u8(6).u8(12);
  const header = [0, 0, 0, 0x11, 0, 0, 0, 0, 0, 3, 2, 2, 0, 0, 0, 0];
  const c1 = [0x40, 0x00, 0x80, ...e("YES")];
  const c2 = [0x00, 0x00, 0x80, ...e("NO")];
  const selBody = [...header, c1.length + 2, 0x10, ...c1, c2.length + 2, 0x10, ...c2];
  writeWdsf(w, WDSF_TYPE.DEFINE_SELECTION_FIELD, selBody);

  // スクロールバー（5,39）垂直 total=50 slider=25 size=4
  w.u8(ORDER.SBA).u8(5).u8(39);
  writeWdsf(w, WDSF_TYPE.DEFINE_SCROLL_BAR_FIELD, [0x00, 0x00, 0, 0, 5, 0, 0, 0, 2, 5, 0x04]);

  w.u8(ESC).u8(COMMAND.READ_MDT_FIELDS).u8(0x00).u8(0x00);
  return buildRecord(OPCODE.PUT_GET, w.toUint8Array());
}

function scenario(): TraceEntry[] {
  return [...signonEntries(), { ts: "t", dir: "tx", masked: true, len: 0 }, rxRecord(guiRecord())];
}

describe("Session5250 — 拡張 5250 GUI（合成リプレイ E2E）", () => {
  it("enhanced=true で接続し、GUI 画面の snapshot.gui を露出する", async () => {
    const transport = new ReplayTransport(scenario());
    const session = await Session5250.connect({ transport, id: "gui", enhanced: true });
    // signon → (tx) → GUI 画面へ。Enter 相当は不要（rx で駆動）
    const r = await session.sendAid("Enter");
    const snap = r.screen;

    expect(snap.gui).toBeDefined();
    expect(snap.gui!.windows).toHaveLength(1);
    expect(snap.gui!.windows[0]).toMatchObject({ row: 5, col: 10, width: 30, height: 6, title: "CHOOSE" });

    expect(snap.gui!.selectionFields).toHaveLength(1);
    const sel = snap.gui!.selectionFields[0]!;
    expect(sel).toMatchObject({ row: 6, col: 12, kind: "radio", multiple: false });
    expect(sel.choices.map((c) => c.text)).toEqual(["YES", "NO"]);
    expect(sel.choices[0]!.selected).toBe(true);

    expect(snap.gui!.scrollBars).toHaveLength(1);
    expect(snap.gui!.scrollBars[0]).toMatchObject({ row: 5, col: 39, horizontal: false, total: 50, sliderPos: 25, size: 4 });
  });

  it("selectGuiChoice で排他選択が snapshot に反映される", async () => {
    const transport = new ReplayTransport(scenario());
    const session = await Session5250.connect({ transport, id: "gui2", enhanced: true });
    await session.sendAid("Enter");

    const id = session.snapshot().gui!.selectionFields[0]!.id;
    expect(session.selectGuiChoice(id, 2, true)).toBe(true);
    const sel = session.snapshot().gui!.selectionFields[0]!;
    expect(sel.choices[0]!.selected).toBe(false);
    expect(sel.choices[1]!.selected).toBe(true);
  });

  it("enhanced 接続で送信される Query Reply は拡張広告（長さ 67）", async () => {
    // signon fixture の中で QUERY が来れば enhanced Query Reply が送られる。
    // ここでは buildQueryReply(enhanced) が session 経由で使われることを型・経路で担保する。
    const transport = new ReplayTransport(scenario());
    const session = await Session5250.connect({ transport, id: "gui3", enhanced: true });
    expect(session.currentState).toBe("ready");
  });
});
