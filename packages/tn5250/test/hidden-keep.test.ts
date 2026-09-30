import { describe, it, expect } from "vitest";
import { applyDataStream } from "../src/protocol/wtd-applier.js";
import { ScreenBuffer } from "../src/screen/buffer.js";
import { keepNarrow, keepWide, rawSentinel } from "../src/screen/attr-sentinel.js";
import { ESC, COMMAND, ORDER, OPCODE } from "../src/protocol/constants.js";
import { Session5250 } from "../src/session/session.js";
import { buildRecord } from "../src/protocol/gds.js";
import type { Transport } from "../src/transport/types.js";
import { codecForCcsid } from "@ts5250/ebcdic/codec";

/**
 * **中身が入って届く非表示（伏せ字）の DBCS 欄**（`20260930-hidden-keep`）。ACS は伏せ字の欄の中身の上に上書きする（実機 `scripts/acs-probe/hidden-dbcs-content.txt`）。
 * 中身はブラウザへ出さない（セルの字は空白）ので、編集は触らない桁を目印（`keepNarrow`・`keepWide`）で持ち、core が元の中身へ戻す（`mergeKeep`）。
 * 画面は (5,10) に非表示の O 欄 12 桁（`SO あ い SI`＋NUL）
 */
const codec = codecForCcsid(930);
function hiddenO(): ScreenBuffer {
  const buf = new ScreenBuffer();
  applyDataStream(
    Uint8Array.from([
      ESC, COMMAND.CLEAR_UNIT, ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00,
      ORDER.SBA, 5, 9, ORDER.SF, 0x40, 0x00, 0x82, 0x80, 0x27, 0x00, 0x0c, 0x0e, 0x44, 0x81, 0x44, 0x82, 0x0f
    ]),
    buf,
    codec,
    () => {}
  );
  return buf;
}
const SO = rawSentinel(0x0e);
const SI = rawSentinel(0x0f);

describe("非表示の欄の触らない桁", () => {
  it("snapshot は中身のある桁に keep を付ける（字は出さない）。SO・SI・空きには付けない", () => {
    const cells = hiddenO().snapshot("s", false).cells[4]!;
    expect(cells.slice(9, 18).map((c) => c.keep === true)).toEqual([false, true, false, true, false, false, false, false, false]);
    expect(cells.slice(9, 18).every((c) => c.char === " ")).toBe(true);
  });

  it("mergeKeep は目印を元の中身へ戻す（全角は桁の頭の番号）", () => {
    const buf = hiddenO();
    const f = buf.orderedFields()[0]!;
    // 欄の桁: 0 SO / 1 あ / 3 い / 5 SI
    expect(buf.mergeKeep(f, SO + "う" + keepWide(3) + SI)).toBe(SO + "う" + "い" + SI);
    expect(buf.mergeKeep(f, SO + keepWide(1) + keepWide(3) + SI)).toBe(SO + "あい" + SI);
  });

  it("半角の中身も桁の番号で戻る（`AB` の 2 桁目の目印は `B`）", () => {
    const buf = new ScreenBuffer();
    applyDataStream(
      Uint8Array.from([ESC, COMMAND.CLEAR_UNIT, ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00, ORDER.SBA, 5, 9, ORDER.SF, 0x40, 0x00, 0x82, 0x80, 0x27, 0x00, 0x0c, 0xc1, 0xc2]),
      buf,
      codec,
      () => {}
    );
    expect(buf.mergeKeep(buf.orderedFields()[0]!, "X" + keepNarrow(1))).toBe("XB");
  });
  it("欄の外・空きを指す目印は空白にする（全角は全角空白）", () => {
    const buf = hiddenO();
    const f = buf.orderedFields()[0]!;
    expect(buf.mergeKeep(f, keepNarrow(9) + keepWide(200))).toBe(" 　");
  });

  it("非表示でない欄の値はそのまま（目印は通常の字ではないので、あとの検証が弾く）", () => {
    const buf = new ScreenBuffer();
    applyDataStream(
      Uint8Array.from([ESC, COMMAND.CLEAR_UNIT, ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00, ORDER.SBA, 5, 9, ORDER.SF, 0x40, 0x00, 0x82, 0x80, 0x20, 0x00, 0x0c, 0x0e, 0x44, 0x81, 0x0f]),
      buf,
      codec,
      () => {}
    );
    const f = buf.orderedFields()[0]!;
    expect(buf.mergeKeep(f, keepWide(1))).toBe(keepWide(1));
  });
});

describe("セッション経由（ws の保存と同じ入口 `setField`）", () => {
  const tick = () => new Promise((r) => setTimeout(r, 10));
  const frame = (opcode: number, data: number[]): number[] => {
    const out: number[] = [];
    for (const b of buildRecord(opcode, Uint8Array.from(data))) {
      out.push(b);
      if (b === 0xff) out.push(0xff);
    }
    return [...out, 0xff, 0xef];
  };
  const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  it("触らない桁の目印を含む値は、READ MDT で元の中身の上に上書きした形（ACS の H1: `0e 4483 4482 0f`）で届く", async () => {
    const written: Uint8Array[] = [];
    let onData: ((d: Uint8Array) => void) | undefined;
    const transport = {
      onData: (cb: (d: Uint8Array) => void) => (onData = cb),
      onClose: () => {},
      onError: () => {},
      send: (d: Uint8Array) => written.push(d),
      close: () => {}
    } as unknown as Transport;
    const p = Session5250.connect({ id: "t", transport, ccsid: 930, negotiationTimeoutMs: 500 });
    await tick();
    onData?.(Uint8Array.from(frame(OPCODE.PUT_GET, [
      ESC, COMMAND.CLEAR_UNIT, ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00,
      ORDER.SBA, 5, 9, ORDER.SF, 0x40, 0x00, 0x82, 0x80, 0x27, 0x00, 0x0c, 0x0e, 0x44, 0x81, 0x44, 0x82, 0x0f,
      ORDER.IC, 5, 10, ESC, COMMAND.READ_MDT_FIELDS, 0x00, 0x00
    ])));
    const s = await p;
    s.setField({ index: 1 }, SO + "う" + keepWide(3) + SI);
    void s.sendAid("Enter", { timeoutMs: 50 }).catch(() => {});
    await tick();
    expect(hex(written.at(-1)!)).toContain("0e448344820f");
  });
});
