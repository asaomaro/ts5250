/**
 * `EmulatorPane` が在席の合図を出すこと。
 *
 * 合図は **DOM の生イベント（keydown / pointerdown を capture）** から出す。
 * 合成イベント（`cursor` / `edit`）は `ScreenGrid.onInputFocus` が emit するため
 * **ホスト発の画面更新でも飛び**、在席と数えると閉じ忘れたタブが永久に生き残る
 * （`20260729-session-lifetime-timeout` spec 方針4 / 非機能要件）。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import EmulatorPane from "../src/components/EmulatorPane.vue";
import { sessionsStore } from "../src/stores/sessions.js";
import type { ScreenSnapshot, Cell, Field } from "@as400web/core";
import type { WsClient } from "../src/ws-client.js";

const SID = "s1";
const send = vi.fn();

function cell(): Cell {
  return {
    char: " ", kind: "sbcs", color: "green",
    reverse: false, underline: false, blink: false, columnSeparator: false, nonDisplay: false
  };
}

function field(): Field {
  return {
    index: 0, row: 2, col: 2, length: 5, protected: false, numeric: false,
    hidden: false, intensified: false, mdt: false, value: "     "
  } as Field;
}

function snap(): ScreenSnapshot {
  const cells: Cell[][] = [];
  for (let r = 0; r < 24; r++) {
    const row: Cell[] = [];
    for (let c = 0; c < 80; c++) row.push(cell());
    cells.push(row);
  }
  return {
    sessionId: SID, rows: 24, cols: 80, cursor: { row: 1, col: 1 },
    keyboardLocked: false, cells, fields: [field()]
  } as ScreenSnapshot;
}

function seed(): void {
  send.mockClear();
  sessionsStore.byId.clear();
  sessionsStore.order = [];
  sessionsStore.add({
    sessionId: SID, label: "t", snapshot: snap(), edits: new Map(),
    cursor: { row: 1, col: 1 }, connected: true, readOnly: false,
    client: { send, setHiddenIndexes: () => {} } as unknown as WsClient
  });
}

const activityCount = (): number =>
  send.mock.calls.filter((c) => (c[0] as { type: string }).type === "activity").length;

function mountPane(): ReturnType<typeof mount> {
  return mount(EmulatorPane, { props: { sessionId: SID, focused: true }, attachTo: document.body });
}

describe("EmulatorPane が在席を伝える", () => {
  beforeEach(() => seed());

  it("**画面を開いただけでは出ない**（ホスト由来の描画・フォーカス合わせは在席ではない）", async () => {
    const w = mountPane();
    await nextTick();
    expect(activityCount()).toBe(0);
    w.unmount();
  });

  it("打鍵で出る", async () => {
    const w = mountPane();
    await nextTick();
    await w.find(".pane").trigger("keydown", { key: "a" });
    expect(activityCount()).toBe(1);
    w.unmount();
  });

  it("クリックで出る", async () => {
    const w = mountPane();
    await nextTick();
    await w.find(".pane").trigger("pointerdown");
    expect(activityCount()).toBe(1);
    w.unmount();
  });

  it("続けて操作しても間引かれる（15 秒に 1 回）", async () => {
    const w = mountPane();
    await nextTick();
    for (let i = 0; i < 5; i++) {
      await w.find(".pane").trigger("keydown", { key: "x" });
      await w.find(".pane").trigger("pointerdown");
    }
    expect(activityCount()).toBe(1);
    w.unmount();
  });

  it("合図に値が乗らない（type だけ）", async () => {
    const w = mountPane();
    await nextTick();
    await w.find(".pane").trigger("keydown", { key: "S" });
    const activity = send.mock.calls.find((c) => (c[0] as { type: string }).type === "activity");
    expect(activity?.[0]).toEqual({ type: "activity" });
    w.unmount();
  });

  it("ホスト発の画面更新では出ない（利用者の在席ではない）", async () => {
    const w = mountPane();
    await nextTick();
    sessionsStore.updateScreen(SID, snap());
    await nextTick();
    expect(activityCount()).toBe(0);
    w.unmount();
  });
});
