import { describe, it, expect, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import ScreenGrid from "../src/components/ScreenGrid.vue";
import type { Cell, Field, ScreenSnapshot } from "@ts5250/tn5250";

/**
 * **自動送りは「カーソルが欄の末尾まで進んだとき」だけ。**
 *
 * 実機の CHGJOB プロンプトで、上書きモードなのに**1 文字打つと次の欄へ飛ぶ**という報告を受けた。
 * 原因は DBCS 欄の判定が「バイト予算が満杯か」だったこと——既に埋まっている欄では 1 打鍵目から
 * 真になる。日本語機は入力欄を `dbcsType: "open"` と宣言するので、見た目が半角だけの欄でも
 * この分岐に入っていた。
 */

const COLS = 80;

function cell(char = " "): Cell {
  return { char, kind: "sbcs", color: "green", reverse: false, underline: false,
    blink: false, columnSeparator: false, nonDisplay: false } as Cell;
}

/** 5 桁の入力欄を 2 つ持つ画面（どちらも dbcsType: "open"＝日本語機の宣言） */
function snapOf(v1: string, v2: string): ScreenSnapshot {
  const cells: Cell[][] = [];
  for (let r = 1; r <= 24; r++) {
    const row: Cell[] = [];
    for (let c = 1; c <= COLS; c++) row.push(cell());
    cells.push(row);
  }
  const put = (row: number, col: number, s: string) =>
    [...s].forEach((ch, i) => (cells[row - 1]![col - 1 + i] = cell(ch)));
  put(5, 10, v1);
  put(6, 10, v2);
  const fields: Field[] = [
    { index: 1, row: 5, col: 10, length: 5, protected: false, hidden: false, numeric: false, mdt: false, value: v1, dbcsType: "open" },
    { index: 2, row: 6, col: 10, length: 5, protected: false, hidden: false, numeric: false, mdt: false, value: v2, dbcsType: "open" }
  ] as Field[];
  return { sessionId: "s", rows: 24, cols: COLS, cursor: { row: 5, col: 10 },
    keyboardLocked: false, cells, fields } as unknown as ScreenSnapshot;
}

function mountGrid(snapshot: ScreenSnapshot) {
  return mount(ScreenGrid, {
    props: { snapshot, edits: new Map(), focused: true, busy: false, cursor: { row: 5, col: 10 } },
    attachTo: document.body
  });
}
const inputs = (w: ReturnType<typeof mountGrid>) =>
  Array.from(w.element.querySelectorAll("input.grid-input:not([readonly])")) as HTMLInputElement[];

describe("満杯の欄での上書き入力（CHGJOB プロンプト相当）", () => {
  beforeEach(() => document.body.replaceChildren());

  it("既に満杯の欄で 1 文字打っても field-full を出さない（次の欄へ飛ばない）", async () => {
    const w = mountGrid(snapOf("11111", "11111"));
    await nextTick();
    const el = inputs(w)[0]!;
    el.focus();
    el.setSelectionRange(0, 0);
    await el.dispatchEvent(new KeyboardEvent("keydown", { key: "2", bubbles: true, cancelable: true }));
    await nextTick();
    expect(w.emitted("field-full")).toBeUndefined();
    w.unmount();
  });

  it("末尾まで打ち切ったら field-full を出す（自動送りは働く）", async () => {
    const w = mountGrid(snapOf("11111", "11111"));
    await nextTick();
    const el = inputs(w)[0]!;
    el.focus();
    el.setSelectionRange(0, 0);
    for (let i = 0; i < 5; i++) {
      await el.dispatchEvent(new KeyboardEvent("keydown", { key: "2", bubbles: true, cancelable: true }));
      await nextTick();
    }
    expect(w.emitted("field-full")).toBeTruthy();
    w.unmount();
  });

  it("空欄でも末尾まで埋めたときだけ field-full を出す", async () => {
    const w = mountGrid(snapOf("     ", "     "));
    await nextTick();
    const el = inputs(w)[0]!;
    el.focus();
    el.setSelectionRange(0, 0);
    for (let i = 0; i < 4; i++) {
      await el.dispatchEvent(new KeyboardEvent("keydown", { key: "9", bubbles: true, cancelable: true }));
      await nextTick();
    }
    expect(w.emitted("field-full"), "4 文字目までは送らない").toBeUndefined();
    await el.dispatchEvent(new KeyboardEvent("keydown", { key: "9", bubbles: true, cancelable: true }));
    await nextTick();
    expect(w.emitted("field-full"), "5 文字目で送る").toBeTruthy();
    w.unmount();
  });
});
