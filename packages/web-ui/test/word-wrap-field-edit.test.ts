import { describe, it, expect, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import ScreenGrid from "../src/components/ScreenGrid.vue";
import type { Cell, Field, ScreenSnapshot } from "@ts5250/tn5250";
import { rawSentinel } from "@ts5250/tn5250/browser";

/**
 * **語送りの欄（FCW 0x8680）に打つと、語が次の行へ送られる**（`20260930-word-wrap`）。期待値は実機の ACS のコア（`scripts/acs-probe/word-wrap.txt`）で
 * ホストが受け取った欄（W1・W3・W6）。欄は (5,70) から 30 桁: 5 行目の 11 桁＋6 行目の頭から 19 桁。
 * 送る値は途中の空きの桁を `rawSentinel(0x00)` で運ぶ（core が NUL のセルにする。実空白は 0x40 で送られる）
 */
const COLS = 80;
const NUL = rawSentinel(0x00);

function cell(char = " "): Cell {
  return { char, kind: "sbcs", color: "green", reverse: false, underline: false, blink: false, columnSeparator: false, nonDisplay: false } as Cell;
}
const wrapField = (over: Partial<Field> = {}): Field =>
  ({ index: 1, row: 5, col: 70, length: 30, protected: false, hidden: false, numeric: false, mdt: false, value: "", wordWrap: true, ...over }) as Field;
function snapOf(f: Field): ScreenSnapshot {
  const cells: Cell[][] = [];
  for (let r = 1; r <= 24; r++) {
    const row: Cell[] = [];
    for (let c = 1; c <= COLS; c++) row.push(cell());
    cells.push(row);
  }
  return { sessionId: "s", rows: 24, cols: COLS, cursor: { row: f.row, col: f.col }, keyboardLocked: false, cells, fields: [f] } as unknown as ScreenSnapshot;
}

describe("語送りの欄の打鍵", () => {
  beforeEach(() => document.body.replaceChildren());

  const edits = new Map<number, string>();
  function mountGrid(f: Field) {
    edits.clear();
    return mount(ScreenGrid, {
      props: { snapshot: snapOf(f), edits, focused: true, busy: false, cursor: { row: f.row, col: f.col } },
      attachTo: document.body
    });
  }
  const pump = (w: ReturnType<typeof mountGrid>): void => {
    for (const [idx, val] of (w.emitted("edit") as unknown[][] | undefined) ?? []) edits.set(idx as number, val as string);
  };
  const slice = (w: ReturnType<typeof mountGrid>, i: number) =>
    w.element.querySelector(`input.grid-input:not([readonly])[data-slice="${i}"]`) as HTMLInputElement;
  async function press(w: ReturnType<typeof mountGrid>, key: string): Promise<void> {
    const el = document.activeElement as HTMLInputElement;
    el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    await nextTick();
    pump(w);
  }
  async function type(w: ReturnType<typeof mountGrid>, text: string): Promise<void> {
    for (const ch of text) await press(w, ch);
  }
  async function focusAt(w: ReturnType<typeof mountGrid>, caret: number, sl = 0) {
    const el = slice(w, sl);
    el.focus();
    el.setSelectionRange(caret, caret);
    await nextTick();
  }
  const sent = (): string | undefined => edits.get(1);

  it("W1: `aaa bbbb cccc dddd` を打つと、cccc 以降が次の行へ。行の残りは空きの桁（NUL）で、実空白ではない", async () => {
    const w = mountGrid(wrapField());
    await nextTick();
    await focusAt(w, 0);
    await type(w, "aaa bbbb cccc dddd");
    expect(sent()).toBe("aaa bbbb " + NUL + NUL + "cccc dddd");
    // 表示は空きの桁も空白（1 行目の 11 桁・2 行目）
    expect(slice(w, 0).value).toBe("aaa bbbb   ");
    expect(slice(w, 1).value.trimEnd()).toBe("cccc dddd");
    w.unmount();
  });

  it("W3: 打った後で真ん中を Delete 2 回すると詰め直される（`aabbbb ` の後ろに NUL 4 つ）", async () => {
    const w = mountGrid(wrapField());
    await nextTick();
    await focusAt(w, 0);
    await type(w, "aaa bbbb cccc dddd");
    await focusAt(w, 2);
    await press(w, "Delete");
    await press(w, "Delete");
    expect(sent()).toBe("aabbbb " + NUL + NUL + NUL + NUL + "cccc dddd");
    w.unmount();
  });

  it("真ん中の Backspace も詰め直す（Delete と同じ手順。実機の W3 の Delete と同じ並びになる）", async () => {
    const w = mountGrid(wrapField());
    await nextTick();
    await focusAt(w, 0);
    await type(w, "aaa bbbb cccc dddd");
    await focusAt(w, 3);
    await press(w, "Backspace");
    await press(w, "Backspace");
    expect(sent()).toBe("a bbbb " + NUL + NUL + NUL + NUL + "cccc dddd");
    w.unmount();
  });

  it("W6: Backspace 6 回で `aaa bbbb ` + NUL 2 つ + `ccc`", async () => {
    const w = mountGrid(wrapField());
    await nextTick();
    await focusAt(w, 0);
    await type(w, "aaa bbbb cccc dddd");
    for (let i = 0; i < 6; i++) await press(w, "Backspace");
    expect(sent()).toBe("aaa bbbb " + NUL + NUL + "ccc");
    w.unmount();
  });

  it("語送りでない欄は従来どおり（行をまたいでも語を送らない）", async () => {
    const { wordWrap: _w, ...plain } = wrapField();
    const w = mountGrid(plain as Field);
    await nextTick();
    await focusAt(w, 0);
    await type(w, "aaa bbbb cccc dddd");
    expect(sent()).toBe("aaa bbbb cccc dddd");
    w.unmount();
  });

  it("ホストが書いた途中の NUL は編集で失われない（値のセンチネルを NUL の桁として持ち回る）", async () => {
    const w = mountGrid(wrapField({ value: "aaa bbbb " + NUL + NUL + "cccc dddd" }));
    await nextTick();
    await focusAt(w, 9, 1); // 2 行目の dddd の後ろ（欄内 20）
    await type(w, "e");
    expect(sent()).toBe("aaa bbbb " + NUL + NUL + "cccc dddde");
    w.unmount();
  });
});
