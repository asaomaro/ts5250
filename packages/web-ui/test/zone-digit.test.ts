import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import { codecForCcsid } from "@ts5250/ebcdic/codec";
import { rawSentinel } from "@ts5250/tn5250/browser";
import type { ScreenSnapshot, Cell, Field } from "@ts5250/tn5250";
import ScreenGrid from "../src/components/ScreenGrid.vue";
import { zoneDigitChar, showSentinels } from "../src/composables/zoneDigit.js";

/**
 * **Field− でゾーンを D にした最終桁は、その字で見せる**（ACS `processFieldPlusMinusAndExit` の `TextPlane[n2] = codepage.sb2uni(s2)`。
 * `20260921-field-minus-zone-d` の節目の独立点検の指摘。以前はセンチネルなので空白に見えた）
 */
describe("ゾーン D の桁の字", () => {
  /** 変換表が持つ CCSID の一覧（`codecForCcsid` が知らない CCSID の誤りに並べる一覧から取る。手で書いた一覧だと足した CCSID が漏れる） */
  const supported = (): number[] => {
    try {
      codecForCcsid(0);
    } catch (e) {
      return [...String((e as Error).message).matchAll(/\d+/g)].map((m) => Number(m[0])).filter((n) => n > 0);
    }
    throw new Error("CCSID 0 が通ってしまった");
  };
  it("**当 PJ が扱う全 CCSID の変換表と一致する**（web-ui が持つのは 10 字だけ）", () => {
    expect(supported().length).toBeGreaterThanOrEqual(10);
    for (const ccsid of supported()) {
      const codec = codecForCcsid(ccsid);
      for (let b = 0xd0; b <= 0xd9; b++) {
        expect(zoneDigitChar(b, ccsid), `CCSID ${ccsid} 0x${b.toString(16)}`).toBe(String.fromCharCode(codec.decodeByte(b)));
      }
    }
  });

  it("ゾーン D 以外のセンチネル（属性・Dup）は空白のまま", () => {
    expect(showSentinels(`12${rawSentinel(0xd5)}${rawSentinel(0x1c)}${rawSentinel(0x22)}`, 37)).toBe("12N  ");
    expect(zoneDigitChar(0xda, 37)).toBeUndefined();
    expect(zoneDigitChar(0xcf, 37)).toBeUndefined();
  });

  it("入力欄の値に字で出る（センチネルを空白にしない）", async () => {
    const cells: Cell[][] = Array.from({ length: 24 }, () =>
      Array.from({ length: 80 }, () => ({ char: " ", kind: "sbcs", color: "green", reverse: false, underline: false, blink: false, columnSeparator: false, nonDisplay: false }) as Cell)
    );
    const f = { index: 1, row: 5, col: 10, length: 6, protected: false, hidden: false, numeric: true, mdt: false, value: "" } as Field;
    const snapshot = { sessionId: "s", rows: 24, cols: 80, cursor: { row: 5, col: 10 }, keyboardLocked: false, cells, fields: [f] } as unknown as ScreenSnapshot;
    const w = mount(ScreenGrid, {
      props: { snapshot, edits: new Map([[1, `12${rawSentinel(0xd0)}`]]), focused: false, busy: false, cursor: { row: 1, col: 1 }, ccsid: 37 }
    });
    await nextTick();
    const el = w.element.querySelector("input.grid-input:not([readonly])") as HTMLInputElement;
    expect(el.value.trimEnd()).toBe("12}");
    w.unmount();
  });
});
