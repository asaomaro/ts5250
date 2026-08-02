import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import ScreenGrid from "../src/components/ScreenGrid.vue";
import EmulatorPane from "../src/components/EmulatorPane.vue";
import { sessionsStore } from "../src/stores/sessions.js";
import type { Cell, Field, ScreenSnapshot } from "@ts5250/tn5250";
import type { WsClient } from "../src/ws-client.js";

/**
 * **欄の先頭で Backspace を押したら、前の入力欄の末尾へ移る（削除はしない）。**
 *
 * 実機はそう振る舞う（GNU tn5250 `display.c` の `kf_backspace`——欄の先頭では
 * 前の欄へカーソルを移すだけで、1 文字も消さない）。
 *
 * これが効くのは **EDTMSK のようにホストが 1 つの項目を複数の入力欄へ分解して送る画面**。
 * 分解された欄は独立した欄なので、これが無いと 2 つ目の欄の先頭が行き止まりになる
 * （`ArrowLeft` は左端でペインのセル移動へ委譲されるのに `Backspace` だけ何もしない、
 * という食い違いもあった）。
 *
 * **欄の中の Backspace は破壊的なまま**（PC の作法）。原典は既定で非破壊だが、
 * そこを変えると既存利用者の操作が全部変わる。欄の先頭は原典も削除しないので食い違わない。
 */

const COLS = 80;
function cell(char = " "): Cell {
  return { char, kind: "sbcs", color: "green", reverse: false, underline: false,
    blink: false, columnSeparator: false, nonDisplay: false } as Cell;
}
function fld(over: Partial<Field> & { index: number; row: number; col: number; length: number }): Field {
  return { protected: false, hidden: false, numeric: false, mdt: false, value: "", ...over } as Field;
}
function snapOf(fields: Field[]): ScreenSnapshot {
  const cells: Cell[][] = [];
  for (let r = 1; r <= 24; r++) {
    const row: Cell[] = [];
    for (let c = 1; c <= COLS; c++) row.push(cell());
    cells.push(row);
  }
  for (const f of fields) [...f.value].forEach((ch, i) => (cells[f.row - 1]![f.col - 1 + i] = cell(ch)));
  return { sessionId: "s1", rows: 24, cols: COLS, cursor: { row: 5, col: 10 },
    keyboardLocked: false, cells, fields } as unknown as ScreenSnapshot;
}

/** EDTMSK 相当: 1 つの項目が 3 つの入力欄へ分解された画面（間に `-` が居る想定） */
const SPLIT = [
  fld({ index: 1, row: 5, col: 10, length: 3, value: "123" }),
  fld({ index: 2, row: 5, col: 14, length: 2, value: "45" }),
  fld({ index: 3, row: 5, col: 17, length: 4, value: "6789" })
];

describe("ScreenGrid: 欄の先頭の Backspace", () => {
  beforeEach(() => document.body.replaceChildren());

  function mountGrid(fields: Field[]) {
    return mount(ScreenGrid, {
      props: { snapshot: snapOf(fields), edits: new Map(), focused: true, busy: false, cursor: { row: 5, col: 10 } },
      attachTo: document.body
    });
  }
  const inputs = (w: ReturnType<typeof mountGrid>) =>
    Array.from(w.element.querySelectorAll("input.grid-input:not([readonly])")) as HTMLInputElement[];

  async function backspaceAt(w: ReturnType<typeof mountGrid>, i: number, caret: number) {
    const el = inputs(w)[i]!;
    el.focus();
    await nextTick();
    el.setSelectionRange(caret, caret);
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true }));
    await nextTick();
    return el;
  }

  it("先頭で押すと field-prev が出て、**値は変わらない**", async () => {
    const w = mountGrid(SPLIT);
    await nextTick();
    await backspaceAt(w, 1, 0);
    expect(w.emitted("field-prev")).toEqual([[2]]); // 2 番目の欄の index
    expect(w.emitted("edit"), "値を書き換えてはいけない").toBeUndefined();
    w.unmount();
  });

  it("途中で押すと従来どおり削除する（field-prev は出ない）", async () => {
    const w = mountGrid(SPLIT);
    await nextTick();
    await backspaceAt(w, 1, 2);
    expect(w.emitted("field-prev")).toBeUndefined();
    const e = w.emitted("edit") as unknown[][];
    expect(e[e.length - 1]![1]).toBe("4"); // "45" の 5 が消える
    w.unmount();
  });

  it("先頭の欄で押しても field-prev は出る（呼び出し側が末尾へ回す）", async () => {
    const w = mountGrid(SPLIT);
    await nextTick();
    await backspaceAt(w, 0, 0);
    expect(w.emitted("field-prev")).toEqual([[1]]);
    w.unmount();
  });
});

describe("EmulatorPane: 前の入力欄の末尾へ移る", () => {
  const SID = "s1";
  let mounted: ReturnType<typeof mount>[] = [];

  function seed(fields: Field[]): void {
    sessionsStore.byId.clear();
    sessionsStore.order = [];
    sessionsStore.add({
      sessionId: SID, label: "t", snapshot: snapOf(fields), edits: new Map(),
      cursor: { row: 5, col: 10 }, connected: true, readOnly: false,
      client: { send: () => {} } as unknown as WsClient
    });
  }
  function mountPane() {
    const w = mount(EmulatorPane, { props: { sessionId: SID, focused: true }, attachTo: document.body });
    mounted.push(w);
    return w;
  }
  const inputs = (w: ReturnType<typeof mountPane>) =>
    Array.from(w.element.querySelectorAll("input.grid-input:not([readonly])")) as HTMLInputElement[];

  beforeEach(() => document.body.replaceChildren());
  afterEach(() => {
    for (const w of mounted) w.unmount();
    mounted = [];
    document.body.innerHTML = "";
  });

  async function backspaceAt(w: ReturnType<typeof mountPane>, i: number, caret: number) {
    const el = inputs(w)[i]!;
    el.focus();
    await nextTick();
    el.setSelectionRange(caret, caret);
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true }));
    await nextTick();
  }

  it("2 つ目の欄の先頭 → 1 つ目の欄にフォーカスが移り caret が末尾", async () => {
    seed(SPLIT);
    const w = mountPane();
    await nextTick();
    await backspaceAt(w, 1, 0);
    const els = inputs(w);
    expect(document.activeElement, "前の欄へ移っていない").toBe(els[0]);
    expect(els[0]!.selectionStart, "caret が末尾に無い").toBe(els[0]!.value.length);
  });

  it("移ったあと続けて Backspace を押せば、その欄の末尾が消える", async () => {
    seed(SPLIT);
    const w = mountPane();
    await nextTick();
    await backspaceAt(w, 1, 0);
    const els = inputs(w);
    els[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true }));
    await nextTick();
    expect(sessionsStore.get(SID)!.edits.get(1)).toBe("12"); // "123" の 3 が消える
  });

  it("先頭の欄では末尾の欄へ回る（onFieldFull と対称）", async () => {
    seed(SPLIT);
    const w = mountPane();
    await nextTick();
    await backspaceAt(w, 0, 0);
    const els = inputs(w);
    expect(document.activeElement).toBe(els[els.length - 1]);
  });

  it("入力欄が 1 つだけなら自分へ戻る（実害なし）", async () => {
    seed([fld({ index: 1, row: 5, col: 10, length: 3, value: "123" })]);
    const w = mountPane();
    await nextTick();
    await backspaceAt(w, 0, 0);
    expect(document.activeElement).toBe(inputs(w)[0]);
  });
});
