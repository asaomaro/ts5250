import { describe, it, expect, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import EmulatorPane from "../src/components/EmulatorPane.vue";
import { sessionsStore } from "../src/stores/sessions.js";
import type { ScreenSnapshot, Cell, Field } from "@as400web/core";
import type { WsClient } from "../src/ws-client.js";

function cell(char = " "): Cell {
  return {
    char,
    kind: "sbcs",
    color: "green",
    reverse: false,
    underline: false,
    blink: false,
    columnSeparator: false,
    nonDisplay: false
  };
}

function snap(fields: Field[]): ScreenSnapshot {
  const cells: Cell[][] = [];
  for (let r = 0; r < 24; r++) {
    const row: Cell[] = [];
    for (let c = 0; c < 80; c++) row.push(cell());
    cells.push(row);
  }
  return { sessionId: "s1", rows: 24, cols: 80, cursor: { row: 1, col: 1 }, keyboardLocked: false, cells, fields };
}

function field(index: number, row: number, protectedField = false): Field {
  return { index, row, col: 10, length: 5, protected: protectedField, hidden: false, numeric: false, mdt: false, value: "" };
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
  return Array.from(w.element.querySelectorAll("input.grid-input:not([readonly])")) as HTMLInputElement[];
}

describe("EmulatorPane フィールド移動（Tab / 矢印）", () => {
  beforeEach(() => seed([field(1, 5), field(2, 6), field(3, 7)]));

  function mountPane() {
    return mount(EmulatorPane, {
      props: { sessionId: SID, focused: true },
      attachTo: document.body
    });
  }

  it("Tab で次の入力欄にフォーカスが移る", async () => {
    const w = mountPane();
    await nextTick(); // マウント時の自動フォーカスを先に確定させる
    const els = inputs(w);
    expect(els).toHaveLength(3);
    els[0]!.focus();
    await w.find(".pane").trigger("keydown", { key: "Tab" });
    expect(document.activeElement).toBe(els[1]);
    w.unmount();
  });

  it("Shift+Tab で前の入力欄へ、先頭では末尾にラップ", async () => {
    const w = mountPane();
    await nextTick(); // マウント時の自動フォーカスを先に確定させる
    const els = inputs(w);
    els[0]!.focus();
    await w.find(".pane").trigger("keydown", { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(els[2]); // ラップ
    w.unmount();
  });

  it("ArrowDown で下の行のフィールドへ、ArrowUp で上へ", async () => {
    const w = mountPane();
    await nextTick(); // マウント時の自動フォーカスを先に確定させる
    const els = inputs(w);
    els[0]!.focus(); // row 5
    await w.find(".pane").trigger("keydown", { key: "ArrowDown" });
    expect(document.activeElement).toBe(els[1]); // row 6
    await w.find(".pane").trigger("keydown", { key: "ArrowUp" });
    expect(document.activeElement).toBe(els[0]); // row 5
    w.unmount();
  });

  it("保護フィールドは移動対象から除外される", async () => {
    seed([field(1, 5), field(2, 6, true), field(3, 7)]); // 中央は保護
    const w = mountPane();
    await nextTick(); // マウント時の自動フォーカスを先に確定させる
    const els = inputs(w);
    expect(els).toHaveLength(2); // 非保護のみ
    els[0]!.focus();
    await w.find(".pane").trigger("keydown", { key: "Tab" });
    expect(document.activeElement).toBe(els[1]); // 保護をスキップ
    w.unmount();
  });

  it("Home/End で最初/最後の入力欄へ（欄外＝ペインにフォーカス時）", async () => {
    const w = mountPane();
    await nextTick(); // マウント時の自動フォーカスを先に確定させる
    const els = inputs(w);
    (w.find(".pane").element as HTMLElement).focus();
    await w.find(".pane").trigger("keydown", { key: "End" });
    expect(document.activeElement).toBe(els[2]);
    await w.find(".pane").trigger("keydown", { key: "Home" });
    expect(document.activeElement).toBe(els[0]);
    w.unmount();
  });

  it("下カーソルは桁を保ち真下のフィールドへ（次項目の先頭に飛ばない・SEU 相当）", async () => {
    // row5: ソース欄(col10) / row6: 行番号欄(col2)＋ソース欄(col10)
    const src5: Field = { index: 1, row: 5, col: 10, length: 20, protected: false, hidden: false, numeric: false, mdt: false, value: "" };
    const seq6: Field = { index: 2, row: 6, col: 2, length: 5, protected: false, hidden: false, numeric: false, mdt: false, value: "" };
    const src6: Field = { index: 3, row: 6, col: 10, length: 20, protected: false, hidden: false, numeric: false, mdt: false, value: "" };
    seed([src5, seq6, src6]);
    const w = mountPane();
    await nextTick();
    const els = inputs(w); // [src5, seq6, src6]（画面順）
    els[0]!.focus(); // row5 ソース欄（col10）
    els[0]!.setSelectionRange(0, 0);
    await w.find(".pane").trigger("keydown", { key: "ArrowDown" });
    // 行番号欄(seq6=els[1]) ではなく、真下の同桁 src6(=els[2]) へ
    expect(document.activeElement).toBe(els[2]);
    w.unmount();
  });
});
