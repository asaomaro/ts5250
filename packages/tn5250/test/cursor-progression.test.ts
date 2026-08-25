import { describe, it, expect } from "vitest";
import { applyDataStream } from "../src/protocol/wtd-applier.js";
import { ScreenBuffer } from "../src/screen/buffer.js";
import { codecForCcsid } from "@ts5250/ebcdic/codec";
import { ORDER, COMMAND, ESC, FFW } from "../src/protocol/constants.js";

/**
 * **カーソル送り（FCW `0x88nn`。DDS の `FLDCSRPRG`）。**
 *
 * ホストが「この欄を出たら画面順の次ではなく nn 番の欄へ」と指定してくる。読み飛ばしていたので
 * Tab の行き先が実機と違っていた。参照実装 2 つとも下位バイトをそのまま欄番号として持つ
 * （GNU tn5250 `nextfieldprogressionid`、tn5250j `ScreenField` の `cursorProg = fcw2`）。
 *
 * 実機（IBM i 7.3・`ASAOLIB/KEYDSPF` の `FLDCSRPRG(IN3)`）で採った SF:
 * `#1 ffw=0x4020 len=5 fcws=[0x8803]` / `#2` `#3` は FCW 無し。
 */

const codec = codecForCcsid(37);

/** 実機と同じ形: 5 桁の入力欄 3 つ。1 つ目に FCW を付けられる */
function screen(fcw?: number[]): ScreenBuffer {
  const b = new ScreenBuffer();
  const sf = (row: number, extra: number[] = []): number[] => [
    ORDER.SBA, row, 29,
    ORDER.SF, 0x40, 0x20, ...extra, 0x20, 0x00, 0x05
  ];
  applyDataStream(
    Uint8Array.from([
      ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x20,
      ...sf(3, fcw ?? []),
      ...sf(5),
      ...sf(7)
    ]),
    b,
    codec,
    () => {}
  );
  return b;
}

describe("FCW 0x88nn（カーソル送り）", () => {
  it("実機で採った `0x8803` を欄番号 3 として読む", () => {
    const snap = screen([0x88, 0x03]).snapshot("s");
    expect(snap.fields).toHaveLength(3);
    expect(snap.fields[0]?.cursorProgression).toBe(3);
    expect(snap.fields[1]?.cursorProgression).toBeUndefined();
    expect(snap.fields[2]?.cursorProgression).toBeUndefined();
  });

  it("指定の無い欄には付けない（`dbcsType` / `adjust` と同じ流儀）", () => {
    const snap = screen().snapshot("s");
    for (const f of snap.fields) expect(f.cursorProgression).toBeUndefined();
  });

  it("**`0x8680`（ワードラップ）や継続入力の FCW と取り違えない**", () => {
    const snap = screen([0x86, 0x80]).snapshot("s");
    expect(snap.fields[0]?.cursorProgression).toBeUndefined();
    const cont = screen([0x86, 0x01]).snapshot("s");
    expect(cont.fields[0]?.cursorProgression).toBeUndefined();
    expect(cont.fields[0]?.continued).toBe("first");
  });

  it("FCW が 2 つ並んでも両方拾う（DBCS 種別 ＋ カーソル送り）", () => {
    const snap = screen([0x82, 0x80, 0x88, 0x02]).snapshot("s");
    expect(snap.fields[0]?.dbcsType).toBe("open");
    expect(snap.fields[0]?.cursorProgression).toBe(2);
  });

  it("FFW は壊さない（欄の型は従来どおり読める）", () => {
    const snap = screen([0x88, 0x03]).snapshot("s");
    expect(snap.fields[0]?.protected).toBe(false);
    expect(snap.fields[0]?.length).toBe(5);
    expect((FFW.ID_MASK & 0x4000) !== 0).toBe(true); // FFW 識別ビットの前提
  });
});
