import { describe, it, expect, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import EmulatorPane from "../src/components/EmulatorPane.vue";
import { sessionsStore } from "../src/stores/sessions.js";
import type { ScreenSnapshot, Cell, Field } from "@ts5250/tn5250";
import type { WsClient } from "../src/ws-client.js";

/**
 * **EDTMSK で分割された欄は Tab で区間ごとに止まらない。**
 *
 * ホストは区切り文字（`/`）を挟んだ**別々の欄**として送ってくるが（`Field.continued`）、
 * ACS は並び全体で**1 つの入力欄**。区間ごとに止まると `2026/08/25` の日付欄を通り抜けるのに
 * Tab を 3 回押すことになり、実機と操作感が違う（利用者報告）。
 *
 * 止めるのは**先頭区間だけ**。打鍵の自動送り（満杯 → 次の区間）は別経路なので影響しない。
 */
const SID = "s1";

function cell(): Cell {
  return { char: " ", kind: "sbcs", color: "green", reverse: false, underline: false,
    blink: false, columnSeparator: false, nonDisplay: false };
}
function snap(fields: Field[]): ScreenSnapshot {
  const cells: Cell[][] = [];
  for (let r = 0; r < 24; r++) {
    const row: Cell[] = [];
    for (let c = 0; c < 80; c++) row.push(cell());
    cells.push(row);
  }
  return { sessionId: SID, rows: 24, cols: 80, cursor: { row: 1, col: 1 }, keyboardLocked: false, cells, fields };
}
function fld(index: number, row: number, col: number, length: number, over: Partial<Field> = {}): Field {
  return { index, row, col, length, protected: false, hidden: false, numeric: false, mdt: false, value: "", ...over };
}
function seed(fields: Field[]): void {
  sessionsStore.byId.clear();
  sessionsStore.order = [];
  sessionsStore.add({
    sessionId: SID, label: "t", snapshot: snap(fields), edits: new Map(),
    cursor: { row: 1, col: 1 }, connected: true, readOnly: false,
    client: { send: () => {} } as unknown as WsClient
  });
}
const mountPane = () => mount(EmulatorPane, { props: { sessionId: SID, focused: true }, attachTo: document.body });
const inputByIndex = (w: ReturnType<typeof mountPane>, index: number) =>
  w.element.querySelector(`input.grid-input[data-field-index="${index}"][data-slice="0"]`) as HTMLInputElement;

/** 単独欄（前） / `9999/99/99` の 3 区間 / 単独欄（後） */
const screen = (): Field[] => [
  fld(1, 3, 10, 5),
  fld(2, 5, 24, 4, { continued: "first" }),
  fld(3, 5, 29, 2, { continued: "middle" }),
  fld(4, 5, 32, 2, { continued: "last" }),
  fld(5, 7, 10, 5)
];

describe("EDTMSK 分割欄の Tab 移動", () => {
  beforeEach(() => seed(screen()));

  it("**先頭区間から Tab で並びの次の欄へ**（中間・最終には止まらない）", async () => {
    const w = mountPane();
    await nextTick();
    inputByIndex(w, 2).focus();
    await nextTick();
    await w.find(".pane").trigger("keydown", { key: "Tab" });
    expect(document.activeElement, "区間で止まっている").toBe(inputByIndex(w, 5));
    w.unmount();
  });

  it("前の欄から Tab で入ると**先頭区間**へ止まる", async () => {
    const w = mountPane();
    await nextTick();
    inputByIndex(w, 1).focus();
    await nextTick();
    await w.find(".pane").trigger("keydown", { key: "Tab" });
    expect(document.activeElement).toBe(inputByIndex(w, 2));
    w.unmount();
  });

  it("中間区間に居ても Tab は並びの次の欄へ（打鍵の自動送りで着いた場合）", async () => {
    const w = mountPane();
    await nextTick();
    inputByIndex(w, 3).focus();
    await nextTick();
    await w.find(".pane").trigger("keydown", { key: "Tab" });
    expect(document.activeElement).toBe(inputByIndex(w, 5));
    w.unmount();
  });

  it("Shift+Tab も並びを 1 つの欄として飛び越す", async () => {
    const w = mountPane();
    await nextTick();
    inputByIndex(w, 5).focus();
    await nextTick();
    await w.find(".pane").trigger("keydown", { key: "Tab", shiftKey: true });
    expect(document.activeElement, "最終区間で止まっている").toBe(inputByIndex(w, 2));
    await w.find(".pane").trigger("keydown", { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(inputByIndex(w, 1));
    w.unmount();
  });

  it("最終区間から Shift+Tab すると並びの前の欄へ", async () => {
    const w = mountPane();
    await nextTick();
    inputByIndex(w, 4).focus();
    await nextTick();
    await w.find(".pane").trigger("keydown", { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(inputByIndex(w, 1));
    w.unmount();
  });

  it("継続でない欄だけの画面は従来どおり（退行防止）", async () => {
    seed([fld(1, 3, 10, 5), fld(2, 5, 10, 5), fld(3, 7, 10, 5)]);
    const w = mountPane();
    await nextTick();
    inputByIndex(w, 1).focus();
    await nextTick();
    await w.find(".pane").trigger("keydown", { key: "Tab" });
    expect(document.activeElement).toBe(inputByIndex(w, 2));
    w.unmount();
  });
});
