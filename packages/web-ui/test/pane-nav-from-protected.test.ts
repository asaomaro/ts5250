import { describe, it, expect, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import EmulatorPane from "../src/components/EmulatorPane.vue";
import { sessionsStore } from "../src/stores/sessions.js";
import type { ScreenSnapshot, Cell, Field } from "@as400web/core";
import type { WsClient } from "../src/ws-client.js";

/**
 * 入力欄の外（非入力セル）にカーソルがある状態からの Tab / Shift+Tab。
 *
 * 入力欄だけの並びで現在位置を探すと、そこに居ないカーソルは見つからず
 * **必ず先頭（Shift+Tab なら末尾）へ飛んでいた**。カーソル位置から見て
 * 次／前の入力欄へ移ること。
 *
 * このアプリは非入力セルに focus を留めない（onCursor が入力欄を blur してペインへ移す）。
 * よって「保護欄にフォーカス」という状態は存在せず、実際は
 * 「ペインにフォーカス・カーソルは画面上の位置」。テストも矢印で欄外へ出て再現する。
 */
function cell(): Cell {
  return {
    char: " ",
    kind: "sbcs",
    color: "green",
    reverse: false,
    underline: false,
    blink: false,
    columnSeparator: false,
    nonDisplay: false
  };
}

function snap(fields: Field[], cursor = { row: 1, col: 1 }): ScreenSnapshot {
  const cells: Cell[][] = [];
  for (let r = 0; r < 24; r++) {
    const row: Cell[] = [];
    for (let c = 0; c < 80; c++) row.push(cell());
    cells.push(row);
  }
  return { sessionId: "s1", rows: 24, cols: 80, cursor, keyboardLocked: false, cells, fields };
}

function field(index: number, row: number): Field {
  return { index, row, col: 10, length: 5, protected: false, hidden: false, numeric: false, mdt: false, value: "" };
}

const SID = "s1";

function seed(fields: Field[]): void {
  sessionsStore.byId.clear();
  sessionsStore.order = [];
  sessionsStore.add({
    sessionId: SID,
    label: "t",
    snapshot: snap(fields),
    edits: new Map(),
    cursor: { row: 1, col: 1 },
    connected: true,
    readOnly: false,
    client: {} as WsClient
  });
}

function inputs(w: ReturnType<typeof mount>): HTMLInputElement[] {
  return Array.from(
    w.element.querySelectorAll('input.grid-input:not([readonly])[data-slice="0"]')
  ) as HTMLInputElement[];
}

function mountPane() {
  return mount(EmulatorPane, { props: { sessionId: SID, focused: true }, attachTo: document.body });
}

describe("欄外にカーソルがある状態からの Tab / Shift+Tab", () => {
  // 入力欄は行 5 / 10 / 15
  beforeEach(() => seed([field(1, 5), field(2, 10), field(3, 15)]));

  /** 行 10 の欄から真下（行 11＝欄外）へ抜け、ペインにフォーカスが移った状態を作る */
  async function parkBelowSecondField(w: ReturnType<typeof mount>) {
    const els = inputs(w);
    els[1]!.focus();
    await nextTick();
    await w.find(".pane").trigger("keydown", { key: "ArrowDown" });
    expect(document.activeElement, "欄外へ出ていない").not.toBe(els[1]);
    return els;
  }

  it("Tab はカーソル位置の次の入力欄へ（先頭へ飛ばない）", async () => {
    const w = mountPane();
    await nextTick();
    const els = await parkBelowSecondField(w);
    await w.find(".pane").trigger("keydown", { key: "Tab" });
    expect(document.activeElement, "先頭へ飛んでいる").toBe(els[2]); // 行 15
    w.unmount();
  });

  it("Shift+Tab はカーソル位置の前の入力欄へ（末尾へ飛ばない）", async () => {
    const w = mountPane();
    await nextTick();
    const els = await parkBelowSecondField(w);
    await w.find(".pane").trigger("keydown", { key: "Tab", shiftKey: true });
    expect(document.activeElement, "末尾へ飛んでいる").toBe(els[1]); // 行 10
    w.unmount();
  });

  it("最後の入力欄より後ろなら Tab は先頭へラップする", async () => {
    seed([field(1, 5), field(2, 10)]); // 行 10 が最後
    const w = mountPane();
    await nextTick();
    const els = await parkBelowSecondField(w); // 行 11（最後の欄より後ろ）
    await w.find(".pane").trigger("keydown", { key: "Tab" });
    expect(document.activeElement).toBe(els[0]); // 行 5 へラップ
    w.unmount();
  });
});

describe("入力可能な欄が 1 つも無い画面", () => {
  beforeEach(() => {
    // 保護欄だけ（確認画面など）
    sessionsStore.byId.clear();
    sessionsStore.order = [];
    const f: Field = {
      index: 1, row: 5, col: 10, length: 5,
      protected: true, hidden: false, numeric: false, mdt: false, value: "X"
    };
    sessionsStore.add({
      sessionId: SID,
      label: "t",
      // カーソルは原点から離れた位置に置く（1,1 のままだと検証にならない）
      snapshot: snap([f], { row: 8, col: 20 }),
      edits: new Map(),
      cursor: { row: 8, col: 20 },
      connected: true,
      readOnly: false,
      client: {} as WsClient
    });
  });

  it("Tab で 1 行 1 桁へカーソルを置く", async () => {
    const w = mountPane();
    await nextTick();
    expect(inputs(w), "編集可能な欄があってはいけない").toHaveLength(0);
    const grid = w.findComponent({ name: "ScreenGrid" });
    expect(grid.props("cursor"), "前提: カーソルは原点にいない").toEqual({ row: 8, col: 20 });
    await w.find(".pane").trigger("keydown", { key: "Tab" });
    await nextTick();
    expect(grid.props("cursor")).toEqual({ row: 1, col: 1 });
    w.unmount();
  });
});
