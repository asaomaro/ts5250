import { describe, it, expect, afterEach, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import EmulatorPane from "../src/components/EmulatorPane.vue";
import { sessionsStore } from "../src/stores/sessions.js";
import type { ScreenSnapshot, Cell, Field } from "@ts5250/tn5250";
import type { WsClient } from "../src/ws-client.js";

/**
 * **Home は画面のホーム位置へ。既にそこなら Record Backspace を送る**（ACS `PS5250.processHome`。
 * `20260921-home-record-backspace`）。
 *
 * 実機の ACS のコア（`scripts/acs-probe/backtab-home.txt`。ADJPGM）: 7,22 で Home → 3,20（欄の先頭ではなく先頭の入力欄）、
 * そこでもう一度 Home → AID 0xF8 を送り、ホストが「機能キーは使用できません」を返した。以前の当 PJ は欄の中なら欄の先頭へ移るだけだった。
 */
const SID = "hk1";

function cell(): Cell {
  return { char: " ", kind: "sbcs", color: "green", reverse: false, underline: false,
    blink: false, columnSeparator: false, nonDisplay: false };
}
function fld(index: number, row: number, extra: Partial<Field> = {}): Field {
  return { index, row, col: 20, length: 6, protected: false, hidden: false, numeric: false,
    mdt: false, value: "", ...extra } as Field;
}
let send: ReturnType<typeof vi.fn>;
function seed(fs: Field[], home?: { row: number; col: number }): void {
  send = vi.fn();
  sessionsStore.byId.clear();
  sessionsStore.order = [];
  const cells: Cell[][] = [];
  for (let r = 0; r < 24; r++) {
    const row: Cell[] = [];
    for (let c = 0; c < 80; c++) row.push(cell());
    cells.push(row);
  }
  const s: ScreenSnapshot = { sessionId: SID, rows: 24, cols: 80, cursor: { row: fs[0]!.row, col: fs[0]!.col },
    keyboardLocked: false, cells, fields: fs, ...(home ? { home } : {}) };
  sessionsStore.add({
    sessionId: SID, label: "t", snapshot: s, edits: new Map(), cursor: s.cursor,
    link: { state: "connected" }, resumability: "resumable", readOnly: false,
    client: { send } as unknown as WsClient
  });
}
const sentKeys = (): string[] =>
  send.mock.calls.map((c) => c[0] as { type: string; key?: string }).filter((m) => m.type === "key").map((m) => m.key!);

let mounted: ReturnType<typeof mount>[] = [];
afterEach(() => {
  for (const w of mounted) w.unmount();
  mounted = [];
  document.body.innerHTML = "";
});
function mountPane() {
  const w = mount(EmulatorPane, { props: { sessionId: SID, focused: true }, attachTo: document.body });
  mounted.push(w);
  return w;
}
const inputOf = (w: ReturnType<typeof mount>, index: number) =>
  w.element.querySelector(`input.grid-input[data-field-index="${index}"][data-slice="0"]`) as HTMLInputElement;
async function key(el: Element, k: string) {
  el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  await nextTick();
  await nextTick();
}
async function focusAt(w: ReturnType<typeof mount>, index: number, caret: number) {
  const el = inputOf(w, index);
  el.focus();
  el.setSelectionRange(caret, caret);
  el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await nextTick();
  return el;
}

describe("Home（ACS `processHome`）", () => {
  it("**欄の途中からは、その欄の先頭ではなくホーム位置（先頭の入力欄）へ**（7,22 → 3,20）", async () => {
    seed([fld(1, 3), fld(2, 5), fld(3, 7)], { row: 3, col: 20 });
    const w = mountPane();
    await nextTick();
    const el = await focusAt(w, 3, 2);
    await key(el, "Home");
    expect(document.activeElement, "欄の先頭に留まっている").toBe(inputOf(w, 1));
    expect((document.activeElement as HTMLInputElement).selectionStart).toBe(0);
    expect(sentKeys()).toEqual([]);
  });

  it("IC で指されたホーム位置（5,23）へは欄の途中の桁まで移る", async () => {
    seed([fld(1, 3), fld(2, 5), fld(3, 7)], { row: 5, col: 23 });
    const w = mountPane();
    await nextTick();
    const el = await focusAt(w, 3, 0);
    await key(el, "Home");
    expect(document.activeElement).toBe(inputOf(w, 2));
    expect((document.activeElement as HTMLInputElement).selectionStart).toBe(3);
  });

  it("**既にホーム位置なら Record Backspace を送る**", async () => {
    seed([fld(1, 3), fld(2, 5)], { row: 3, col: 20 });
    const w = mountPane();
    await nextTick();
    const el = await focusAt(w, 1, 0);
    await key(el, "Home");
    expect(sentKeys()).toEqual(["RecordBackspace"]);
  });

  it("ホーム位置へ移った後の 2 回目の Home で送る（ACS の手順どおり）", async () => {
    seed([fld(1, 3), fld(2, 5)], { row: 3, col: 20 });
    const w = mountPane();
    await nextTick();
    const el = await focusAt(w, 2, 3);
    await key(el, "Home");
    expect(sentKeys()).toEqual([]);
    await key(document.activeElement!, "Home");
    expect(sentKeys()).toEqual(["RecordBackspace"]);
  });

  it("右寄せの欄に打ったままでも Record Backspace は 0020 で止めない（ACS は 248 を検査から外す）", async () => {
    seed([fld(1, 3, { adjust: "right-zero" }), fld(2, 5)], { row: 3, col: 20 });
    const w = mountPane();
    await nextTick();
    const el = await focusAt(w, 1, 0);
    await key(el, "1");
    // 欄の中の左矢印で戻る（欄を出ていないので 0020 の待ちは残る）→ ホーム位置で Home
    await key(document.activeElement!, "ArrowLeft");
    await key(document.activeElement!, "Home");
    expect(sentKeys()).toEqual(["RecordBackspace"]);
  });

  it("**ホームの欄の途中で打って Home（同じ欄の先頭へ）→ Enter は送れる**（ACS は出た欄の印を立てる）", async () => {
    seed([fld(1, 3, { adjust: "right-zero" }), fld(2, 5)], { row: 3, col: 20 });
    const w = mountPane();
    await nextTick();
    const el = await focusAt(w, 1, 0);
    await key(el, "1");
    await key(document.activeElement!, "2");
    await key(document.activeElement!, "Home");
    expect(document.activeElement, "前提: 同じ欄").toBe(inputOf(w, 1));
    await key(document.activeElement!, "Enter");
    expect(sentKeys()).toEqual(["Enter"]);
  });

  it("**3270 のセッションでは Record Backspace を送らない**（先頭の入力欄へ移るだけ。独立点検の指摘）", async () => {
    seed([fld(1, 3), fld(2, 5)]);
    sessionsStore.get(SID)!.meta = { terminal: "3270" };
    const w = mountPane();
    await nextTick();
    const el = await focusAt(w, 1, 0);
    await key(el, "Home");
    expect(sentKeys()).toEqual([]);
    const el2 = await focusAt(w, 2, 2);
    await key(el2, "Home");
    expect(document.activeElement).toBe(inputOf(w, 1));
  });

  it("ホーム位置の無い手組みの画面は先頭の入力欄をホームとみなす（従来の fallback）", async () => {
    seed([fld(1, 3), fld(2, 5)]);
    const w = mountPane();
    await nextTick();
    const el = await focusAt(w, 2, 2);
    await key(el, "Home");
    expect(document.activeElement).toBe(inputOf(w, 1));
  });
});
