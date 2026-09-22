import { describe, it, expect, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import EmulatorPane from "../src/components/EmulatorPane.vue";
import { sessionsStore } from "../src/stores/sessions.js";
import type { ScreenSnapshot, Cell, Field } from "@ts5250/tn5250";
import type { WsClient } from "../src/ws-client.js";

/**
 * **Newline は次の行の先頭から見て最初の入力欄へ移る。ホストへは送らない**
 * （`20260921-shift-enter-newline`）。
 *
 * ACS `PS5250.processNewline` は次の行の先頭位置を起点に
 * `FFT5250.nextNonByPassInputFieldPos` で次の入力欄を探す。下に無ければ先頭へ巡回する。
 */
const SID = "s1";
const cell = (): Cell =>
  ({ char: " ", kind: "sbcs", color: "green", reverse: false, underline: false,
     blink: false, columnSeparator: false, nonDisplay: false }) as Cell;
const fld = (index: number, row: number, col: number): Field =>
  ({ index, row, col, length: 5, protected: false, hidden: false, numeric: false, mdt: false, value: "" }) as Field;

function snap(fields: Field[], cursor: { row: number; col: number }): ScreenSnapshot {
  const cells: Cell[][] = [];
  for (let r = 0; r < 24; r++) { const row: Cell[] = []; for (let c = 0; c < 80; c++) row.push(cell()); cells.push(row); }
  return { sessionId: SID, rows: 24, cols: 80, cursor, keyboardLocked: false, cells, fields } as unknown as ScreenSnapshot;
}

describe("Newline（Shift+Enter）", () => {
  let sent: unknown[] = [];
  function seed(s: ScreenSnapshot): void {
    sent = [];
    sessionsStore.byId.clear();
    sessionsStore.order = [];
    sessionsStore.add({
      sessionId: SID, label: "t", snapshot: s, edits: new Map(), cursor: s.cursor,
      link: { state: "connected" }, resumability: "resumable", readOnly: false,
      client: { send: (m: unknown) => sent.push(m) } as unknown as WsClient
    });
  }
  beforeEach(() => document.body.replaceChildren());

  const inputAt = (w: ReturnType<typeof mount>, idx: number) =>
    w.element.querySelector(`input.grid-input[data-field-index="${idx}"][data-slice="0"]`) as HTMLInputElement;

  it("次の行の最初の入力欄へ移り、ホストへは何も送らない", async () => {
    // 5 行目に 2 欄、7 行目に 1 欄。カーソルは 5 行目の 2 欄目
    seed(snap([fld(1, 5, 10), fld(2, 5, 30), fld(3, 7, 10)], { row: 5, col: 30 }));
    const w = mount(EmulatorPane, { props: { sessionId: SID, focused: true }, attachTo: document.body });
    await nextTick();
    await w.find(".pane").trigger("keydown", { key: "Enter", shiftKey: true });
    await nextTick();
    expect(document.activeElement, "同じ行の次の欄ではなく、次の行の欄へ").toBe(inputAt(w, 3));
    expect(sent.filter((m) => (m as { type?: string }).type === "key"), "送信してはいけない").toEqual([]);
    w.unmount();
  });

  it("下に入力欄が無ければ先頭の入力欄へ巡回する", async () => {
    seed(snap([fld(1, 5, 10), fld(2, 7, 10)], { row: 7, col: 10 }));
    const w = mount(EmulatorPane, { props: { sessionId: SID, focused: true }, attachTo: document.body });
    await nextTick();
    await w.find(".pane").trigger("keydown", { key: "Enter", shiftKey: true });
    await nextTick();
    expect(document.activeElement).toBe(inputAt(w, 1));
    w.unmount();
  });
});
