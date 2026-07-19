import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ScreenSnapshot } from "@as400web/core";

// WsClient をモック（connect 即時解決・send スパイ・handlers 捕捉）
let captured: { handlers: { onServerMessage: (m: unknown) => void }; send: ReturnType<typeof vi.fn> };
vi.mock("../src/ws-client.js", () => ({
  WsClient: class {
    send = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(_url: string, handlers: any) {
      captured = { handlers, send: this.send };
    }
    connect() {
      return Promise.resolve();
    }
    close() {}
    setHiddenIndexes() {}
    setSessionId() {}
  }
}));

import { openSession, sendKey } from "../src/session-controller.js";
import { sessionsStore } from "../src/stores/sessions.js";

function snap(): ScreenSnapshot {
  return {
    sessionId: "s1",
    rows: 24,
    cols: 80,
    cursor: { row: 1, col: 1 },
    keyboardLocked: false,
    cells: [],
    fields: []
  };
}

describe("通信中プロテクト・0.5 秒ローディング", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sessionsStore.byId.clear();
    sessionsStore.order = [];
  });
  afterEach(() => vi.useRealTimers());

  async function open() {
    const p = openSession({ type: "open", host: "h" }, "t");
    captured.handlers.onServerMessage({ type: "opened", sessionId: "s1", screen: snap() });
    await p;
    captured.send.mockClear(); // open メッセージの送信をカウントから除く
  }

  it("送信で busy=true、0.5 秒未満はローディングなし、0.5 秒超でローディング表示", async () => {
    await open();
    sendKey("s1", "Enter");
    const s = sessionsStore.get("s1")!;
    expect(s.busy).toBe(true);
    expect(s.loading).toBe(false); // 送信直後はスピナー出さない
    expect(captured.send).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(499);
    expect(s.loading).toBe(false); // 0.5 秒未満
    vi.advanceTimersByTime(1);
    expect(s.loading).toBe(true); // 0.5 秒到達でローディング
  });

  it("応答（screen）で busy/loading が解除される", async () => {
    await open();
    sendKey("s1", "Enter");
    vi.advanceTimersByTime(500);
    expect(sessionsStore.get("s1")!.loading).toBe(true);

    captured.handlers.onServerMessage({ type: "screen", screen: snap() });
    const s = sessionsStore.get("s1")!;
    expect(s.busy).toBe(false);
    expect(s.loading).toBe(false);
  });

  it("0.5 秒未満で応答が来ればローディングは出ない", async () => {
    await open();
    sendKey("s1", "Enter");
    vi.advanceTimersByTime(200);
    captured.handlers.onServerMessage({ type: "screen", screen: snap() });
    vi.advanceTimersByTime(500); // タイマーは解除済み
    expect(sessionsStore.get("s1")!.loading).toBe(false);
  });

  it("通信中（busy）は多重送信をプロテクトする", async () => {
    await open();
    sendKey("s1", "Enter");
    expect(captured.send).toHaveBeenCalledTimes(1);
    sendKey("s1", "F3"); // busy 中は無視
    expect(captured.send).toHaveBeenCalledTimes(1);
  });
});
