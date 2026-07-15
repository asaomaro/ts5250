import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount } from "@vue/test-utils";
import EmulatorPane from "../src/components/EmulatorPane.vue";
import { sessionsStore } from "../src/stores/sessions.js";
import type { ScreenSnapshot, Cell } from "@as400web/core";
import type { WsClient } from "../src/ws-client.js";

function cells(): Cell[][] {
  const out: Cell[][] = [];
  for (let r = 0; r < 24; r++) {
    const row: Cell[] = [];
    for (let c = 0; c < 80; c++) {
      row.push({ char: " ", kind: "sbcs", color: "green", reverse: false, underline: false, blink: false, columnSeparator: false, nonDisplay: false });
    }
    out.push(row);
  }
  return out;
}

const SID = "w1";

function seed(locked: boolean): ReturnType<typeof vi.fn> {
  const send = vi.fn();
  const snapshot: ScreenSnapshot = {
    sessionId: SID,
    rows: 24,
    cols: 80,
    cursor: { row: 3, col: 5 },
    keyboardLocked: locked,
    cells: cells(),
    fields: []
  };
  sessionsStore.byId.clear();
  sessionsStore.order = [];
  sessionsStore.add({
    sessionId: SID,
    label: "t",
    snapshot,
    edits: new Map(),
    cursor: { row: 3, col: 5 },
    connected: true,
    readOnly: false,
    client: { send } as unknown as WsClient
  });
  return send;
}

function mountPane() {
  return mount(EmulatorPane, { props: { sessionId: SID, focused: true }, attachTo: document.body });
}

describe("EmulatorPane マウスホイールでページ送り（ACS 準拠）", () => {
  beforeEach(() => vi.useRealTimers());

  it("ホイール下で PageDown を送る（カーソル付き）", async () => {
    const send = seed(false);
    const w = mountPane();
    await w.find(".pane").trigger("wheel", { deltaY: 120 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toMatchObject({ type: "key", key: "PageDown", cursor: { row: 3, col: 5 } });
    w.unmount();
  });

  it("ホイール上で PageUp を送る", async () => {
    const send = seed(false);
    const w = mountPane();
    await w.find(".pane").trigger("wheel", { deltaY: -120 });
    expect(send.mock.calls[0]![0]).toMatchObject({ type: "key", key: "PageUp" });
    w.unmount();
  });

  it("キーボードロック中は送らない", async () => {
    const send = seed(true);
    const w = mountPane();
    await w.find(".pane").trigger("wheel", { deltaY: 120 });
    expect(send).not.toHaveBeenCalled();
    w.unmount();
  });

  it("連続ホイールはクールダウンで 1 ページに抑制される", async () => {
    const send = seed(false);
    const w = mountPane();
    await w.find(".pane").trigger("wheel", { deltaY: 120 });
    await w.find(".pane").trigger("wheel", { deltaY: 120 });
    await w.find(".pane").trigger("wheel", { deltaY: 120 });
    expect(send).toHaveBeenCalledTimes(1); // 直近ジェスチャは 1 回だけ
    w.unmount();
  });

  it("微小デルタ（ジッタ）は無視する", async () => {
    const send = seed(false);
    const w = mountPane();
    await w.find(".pane").trigger("wheel", { deltaY: 2 });
    expect(send).not.toHaveBeenCalled();
    w.unmount();
  });
});
