/**
 * 在席の合図（`activity`）とハートビートの自動応答（`pong`）。
 *
 * 打った文字は AID キーを押すまで送らないので、これが無いとサーバーからは打鍵中が
 * 無操作に見え、アイドルタイムアウトに有限値を設定したときに**打ち込み途中で切られる**
 * （`20260729-session-lifetime-timeout` spec 方針4）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ScreenSnapshot } from "@as400web/core";

let captured: { handlers: { onServerMessage: (m: unknown) => void }; send: ReturnType<typeof vi.fn> };
vi.mock("../src/ws-client.js", () => ({
  // `session-controller` が `wsUrl` も import するので、モックにも持たせる
  wsUrl: () => "ws://test/ws",
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

import { openSession, noteActivity, closeSession } from "../src/session-controller.js";
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

describe("noteActivity", () => {
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
    captured.send.mockClear();
  }

  it("合図を送る。**値を載せない**（type だけ）", async () => {
    await open();
    noteActivity("s1");
    expect(captured.send).toHaveBeenCalledTimes(1);
    expect(captured.send.mock.calls[0]?.[0]).toEqual({ type: "activity" });
  });

  it("連打しても間引く（15 秒に 1 回）", async () => {
    await open();
    for (let i = 0; i < 20; i++) noteActivity("s1");
    expect(captured.send).toHaveBeenCalledTimes(1);
  });

  it("15 秒経てばまた送る", async () => {
    await open();
    noteActivity("s1");
    vi.advanceTimersByTime(15_000);
    noteActivity("s1");
    expect(captured.send).toHaveBeenCalledTimes(2);
  });

  it("15 秒未満では送らない", async () => {
    await open();
    noteActivity("s1");
    vi.advanceTimersByTime(14_999);
    noteActivity("s1");
    expect(captured.send).toHaveBeenCalledTimes(1);
  });

  it("未知のセッションでは何もしない", async () => {
    await open();
    noteActivity("nope");
    expect(captured.send).not.toHaveBeenCalled();
  });

  it("閉じて開き直したセッションは間引きを持ち越さない", async () => {
    await open();
    noteActivity("s1");
    closeSession("s1");
    captured.send.mockClear();
    await open();
    noteActivity("s1");
    expect(captured.send).toHaveBeenCalledWith({ type: "activity" });
  });
});
