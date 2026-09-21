import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import EmulatorPane from "../src/components/EmulatorPane.vue";
import { sessionsStore } from "../src/stores/sessions.js";
import type { ScreenSnapshot, Cell, Field } from "@ts5250/tn5250";
import type { WsClient } from "../src/ws-client.js";

/**
 * **Backtab は ACS と同じ行き先へ**（`PS5250.processBacktab` → `FFT5250.previousNonByPassInputFieldPos`。
 * `20260921-backtab-acs`）。
 *
 * 行き先は「カーソルの 1 つ手前以前で始まる最後の入力欄の先頭」。**欄の途中ならその欄の先頭で止まる**。
 * 以前は常に前の停止点へ移っていた。例は実機の ACS のコアで測ったもの（`scripts/acs-probe/backtab-home.txt`:
 * 7,22 → 7,20 ／ 7,20 → 5,20 ／ 3,20 → 19,20 ／ 6,40 → 5,20 ／ 7,26 → 7,20）。
 */
const SID = "bt1";

function cell(): Cell {
  return { char: " ", kind: "sbcs", color: "green", reverse: false, underline: false,
    blink: false, columnSeparator: false, nonDisplay: false };
}
function fld(index: number, row: number, extra: Partial<Field> = {}): Field {
  return { index, row, col: 20, length: 6, protected: false, hidden: false, numeric: false,
    mdt: false, value: "", ...extra } as Field;
}
let fields: Field[] = [];
let send: ReturnType<typeof vi.fn>;
function seed(fs: Field[]): void {
  fields = fs;
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
    keyboardLocked: false, cells, fields: fs };
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
const inputOf = (w: ReturnType<typeof mount>, index: number, slice = 0) =>
  w.element.querySelector(`input.grid-input[data-field-index="${index}"][data-slice="${slice}"]`) as HTMLInputElement;
/** 欄 index の caret に置いて、その input で Shift+Tab（keydown は欄 → ペインへ伝わる。実物と同じ順） */
async function backtabFrom(w: ReturnType<typeof mount>, index: number, caret: number, slice = 0) {
  const el = inputOf(w, index, slice);
  el.focus();
  el.setSelectionRange(caret, caret);
  await nextTick();
  el.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }));
  await nextTick();
}

describe("Backtab の行き先（ADJPGM と同じ並び: 3,20 から 2 行おきに 5 つ）", () => {
  beforeEach(() => seed([fld(1, 3), fld(2, 5), fld(3, 7), fld(4, 9), fld(5, 11)]));

  it("**欄の途中ならその欄の先頭で止まる**（B1: 7,22 → 7,20）", async () => {
    const w = mountPane();
    await nextTick();
    await backtabFrom(w, 3, 2);
    expect(document.activeElement, "前の欄へ行っている").toBe(inputOf(w, 3));
    expect((document.activeElement as HTMLInputElement).selectionStart).toBe(0);
  });

  it("欄の先頭なら前の欄の先頭へ（B2: 7,20 → 5,20）", async () => {
    const w = mountPane();
    await nextTick();
    await backtabFrom(w, 3, 0);
    expect(document.activeElement).toBe(inputOf(w, 2));
  });

  it("先頭の欄の先頭からは最後の欄へ回り込む（B3）", async () => {
    const w = mountPane();
    await nextTick();
    await backtabFrom(w, 1, 0);
    expect(document.activeElement).toBe(inputOf(w, 5));
  });

  it("欄の最終桁の直後（境界）からもその欄の先頭へ（B6: 7,26 → 7,20）", async () => {
    const w = mountPane();
    await nextTick();
    await backtabFrom(w, 3, 6);
    expect(document.activeElement).toBe(inputOf(w, 3));
  });
});

describe("Backtab と「欄を出た」（エラー 0020）", () => {
  it("**右寄せの欄に打って Backtab で同じ欄の先頭へ戻っても、Enter は送れる**（ACS は着いた欄の印を立てる）", async () => {
    seed([fld(1, 3), fld(2, 5, { adjust: "right-zero" }), fld(3, 7)]);
    const w = mountPane();
    await nextTick();
    const el = inputOf(w, 2);
    el.focus();
    el.setSelectionRange(0, 0);
    await nextTick();
    for (const ch of "12") el.dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true, cancelable: true }));
    await nextTick();
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }));
    await nextTick();
    expect(document.activeElement, "前提: 同じ欄に留まる").toBe(el);
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await nextTick();
    expect(sentKeys()).toEqual(["Enter"]);
  });
});

describe("Backtab で同じ欄の先頭へ戻ったとき、ペインのカーソルも欄の先頭になる（独立点検の指摘）", () => {
  it("**欄の途中から Backtab → Enter は欄の先頭（7,20）を送る**（7,22 のまま送っていた）", async () => {
    seed([fld(1, 3), fld(2, 5), fld(3, 7)]);
    const w = mountPane();
    await nextTick();
    const el = inputOf(w, 3);
    el.focus();
    el.setSelectionRange(0, 0);
    await nextTick();
    for (const ch of "AB") el.dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true, cancelable: true }));
    await nextTick();
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }));
    await nextTick();
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await nextTick();
    const sent = send.mock.calls.map((c) => c[0] as { type: string; cursor?: unknown }).filter((m) => m.type === "key");
    expect(sent.map((m) => m.cursor)).toEqual([{ row: 7, col: 20 }]);
  });

  it("ホームの欄の途中から Backtab → Home は Record Backspace を送る（カーソルがホーム位置に居る）", async () => {
    const fs = [fld(1, 3), fld(2, 5)];
    seed(fs);
    sessionsStore.get(SID)!.snapshot = { ...sessionsStore.get(SID)!.snapshot!, home: { row: 3, col: 20 } };
    const w = mountPane();
    await nextTick();
    await backtabFrom(w, 1, 3);
    (document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true }));
    await nextTick();
    expect(sentKeys()).toEqual(["RecordBackspace"]);
  });
});

describe("Backtab: 行をまたぐ欄・カーソル送り", () => {
  it("行をまたぐ欄の 2 行目からは欄の先頭（1 行目の先頭）へ", async () => {
    seed([fld(1, 18), { ...fld(2, 20), col: 7, length: 153 }]);
    const w = mountPane();
    await nextTick();
    await backtabFrom(w, 2, 5, 1);
    expect(document.activeElement).toBe(inputOf(w, 2, 0));
    expect((document.activeElement as HTMLInputElement).selectionStart).toBe(0);
  });

  it("**欄の先頭では、そこへカーソル送りで来る欄へ戻る**（ACS は FCW 0x88 を逆にも辿る）", async () => {
    // IN1 → IN3 のカーソル送り（実機 KEYPGM と同じ形）。IN3 の先頭で Backtab → 画面順の IN2 ではなく IN1
    seed([fld(1, 3, { cursorProgression: 3 }), fld(2, 5), fld(3, 7)]);
    const w = mountPane();
    await nextTick();
    await backtabFrom(w, 3, 0);
    expect(document.activeElement, "画面順の前（IN2）へ行っている").toBe(inputOf(w, 1));
  });

  it("欄の途中ではカーソル送りを見ず、その欄の先頭で止まる", async () => {
    seed([fld(1, 3, { cursorProgression: 3 }), fld(2, 5), fld(3, 7)]);
    const w = mountPane();
    await nextTick();
    await backtabFrom(w, 3, 3);
    expect(document.activeElement).toBe(inputOf(w, 3));
  });
});
