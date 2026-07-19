import { describe, it, expect, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import EmulatorPane from "../src/components/EmulatorPane.vue";
import { sessionsStore } from "../src/stores/sessions.js";
import type { ScreenSnapshot, Cell, Field } from "@as400web/core";
import type { WsClient } from "../src/ws-client.js";

/**
 * **欄外（保護領域・非入力セル）での入力とペースト。**
 *
 * このアプリは保護欄に focus を留めない（reconcileFocus が blur してペインへ移す）。
 * よって ScreenGrid の `@keydown` / `@paste` は**保護欄には届かない**。
 * ScreenGrid 単体テストで readonly の input へイベントを送っても、
 * 実機では通らない経路を検証していることになる（PR #90 の取りこぼし）。
 *
 * ここでは実機と同じく **EmulatorPane 起点**で検証する。
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

function snap(fields: Field[], cursor: { row: number; col: number }): ScreenSnapshot {
  const cells: Cell[][] = [];
  for (let r = 0; r < 24; r++) {
    const row: Cell[] = [];
    for (let c = 0; c < 80; c++) row.push(cell());
    cells.push(row);
  }
  return { sessionId: "s1", rows: 24, cols: 80, cursor, keyboardLocked: false, cells, fields };
}

function fld(index: number, row: number, col: number, length: number, prot = false): Field {
  return {
    index, row, col, length,
    protected: prot, hidden: false, numeric: false, mdt: false, value: ""
  };
}

const SID = "s1";

function seed(fields: Field[], cursor: { row: number; col: number }): void {
  sessionsStore.byId.clear();
  sessionsStore.order = [];
  sessionsStore.add({
    sessionId: SID,
    label: "t",
    snapshot: snap(fields, cursor),
    edits: new Map(),
    cursor,
    connected: true,
    readOnly: false,
    client: {} as WsClient
  });
}

function mountPane() {
  return mount(EmulatorPane, { props: { sessionId: SID, focused: true }, attachTo: document.body });
}

function statusText(w: ReturnType<typeof mountPane>): string {
  return w.findComponent({ name: "StatusBar" }).text();
}

const PROTECTED_MSG = "Cursor in protected area of display.";

describe("保護領域での文字入力・削除", () => {
  // 入力欄は行 5。カーソルは行 10（欄外）
  beforeEach(() => seed([fld(1, 5, 10, 5)], { row: 10, col: 20 }));

  it("文字キーでメッセージが出る", async () => {
    const w = mountPane();
    await nextTick();
    await w.find(".pane").trigger("keydown", { key: "A" });
    expect(statusText(w)).toContain(PROTECTED_MSG);
    w.unmount();
  });

  it("Backspace・Delete でもメッセージが出る", async () => {
    for (const key of ["Backspace", "Delete"]) {
      const w = mountPane();
      await nextTick();
      await w.find(".pane").trigger("keydown", { key });
      expect(statusText(w), `${key} で出ていない`).toContain(PROTECTED_MSG);
      w.unmount();
    }
  });

  it("カーソルキーではメッセージを出さない", async () => {
    const w = mountPane();
    await nextTick();
    await w.find(".pane").trigger("keydown", { key: "ArrowRight" });
    expect(statusText(w)).not.toContain(PROTECTED_MSG);
    w.unmount();
  });
});

describe("保護領域からのペースト", () => {
  it("同じ行の右にある入力欄へ流し込む（メッセージは出さない）", async () => {
    // 行 5: 桁 10-12 が保護・桁 15 から入力欄。カーソルは保護側
    seed([fld(1, 5, 10, 3, true), fld(2, 5, 15, 4)], { row: 5, col: 10 });
    const w = mountPane();
    await nextTick();
    (document.activeElement as HTMLElement | null)?.blur();
    await w.find(".pane").trigger("paste", {
      clipboardData: { getData: () => "ABCD" }
    } as unknown as ClipboardEvent);
    await nextTick();
    expect(sessionsStore.byId.get(SID)!.edits.get(2), "右の入力欄へ入っていない").toBe("ABCD");
    expect(statusText(w), "ペーストでメッセージを出してはいけない").not.toContain(PROTECTED_MSG);
    w.unmount();
  });

  it("その行に入力欄が無ければ何も起きない", async () => {
    seed([fld(1, 5, 10, 4)], { row: 5, col: 10 });
    const w = mountPane();
    await nextTick();
    // マウント時の自動フォーカスでカーソルが欄へ乗るため、実際の操作（矢印）で欄外へ出す
    await w.find(".pane").trigger("keydown", { key: "ArrowDown" });
    const grid = w.findComponent({ name: "ScreenGrid" });
    expect(grid.props("cursor"), "前提: カーソルが欄外の行にいる").toEqual({ row: 6, col: 10 });

    await w.find(".pane").trigger("paste", {
      clipboardData: { getData: () => "ABCD" }
    } as unknown as ClipboardEvent);
    await nextTick();
    expect(sessionsStore.byId.get(SID)!.edits.size, "下の行へ飛ばしてはいけない").toBe(0);
    w.unmount();
  });
});
