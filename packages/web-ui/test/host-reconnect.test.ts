/**
 * **ホストに切られて、サーバーが自動で繋ぎ直している間の画面側**（`20260921-auto-reconnect`）。
 *
 * 繋ぎ直しそのものはサーバー（コアの `autoReconnect`）。ブラウザは:
 *   - `host-reconnecting` で「繋ぎ直しています」を出し、**送らない**（フラグキーも。送り先が無い）
 *   - 溜めた先打ちを捨てる（ACS も通信が準備できていない間の打鍵は捨てる）
 *   - `host-reconnected` で通知を消し、送れる状態に戻る
 * ブラウザ ↔ サーバーの繋ぎ直し（`link`）とは別の状態であることも固定する。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ScreenSnapshot } from "@ts5250/tn5250";

interface Fake {
  handlers: { onServerMessage: (m: unknown) => void };
  send: ReturnType<typeof vi.fn>;
}
let clients: Fake[] = [];

vi.mock("../src/ws-client.js", () => ({
  wsUrl: () => "ws://test/ws",
  WsClient: class {
    send = vi.fn();
    close = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(_url: string, handlers: any) {
      clients.push({ handlers, send: this.send });
    }
    connect() {
      return Promise.resolve();
    }
    setHiddenIndexes() {}
    setSessionId() {}
  }
}));

import { openSession, sendKey, closeSession } from "../src/session-controller.js";
import { sessionsStore } from "../src/stores/sessions.js";
import { msgHostReconnecting } from "../src/composables/opMessages.js";

function snap(keyboardLocked = false): ScreenSnapshot {
  return {
    sessionId: "s1", rows: 24, cols: 80, cursor: { row: 5, col: 10 }, keyboardLocked, cells: [], fields: []
  } as unknown as ScreenSnapshot;
}
async function open() {
  const p = openSession({ type: "open", host: "h" }, "t");
  clients[0]!.handlers.onServerMessage({ type: "opened", sessionId: "s1", screen: snap() });
  await p;
  return sessionsStore.get("s1")!;
}
const keysSent = () =>
  clients[0]!.send.mock.calls.map((c) => c[0] as { type: string; key?: string }).filter((m) => m.type === "key");

describe("ホストへの自動再接続（ブラウザ側）", () => {
  beforeEach(() => {
    clients = [];
    sessionsStore.byId.clear();
    sessionsStore.order = [];
  });
  afterEach(() => {
    if (sessionsStore.get("s1")) closeSession("s1");
  });

  it("**繋ぎ直している間は通知を出し、送らない**（フラグキーも）", async () => {
    const s = await open();
    clients[0]!.handlers.onServerMessage({ type: "host-reconnecting", attempt: 1, reason: "socket closed" });
    expect(s.notice).toBe(msgHostReconnecting(1));
    expect(s.hostReconnect).toEqual({ attempt: 1 });
    sendKey("s1", "Enter");
    sendKey("s1", "Attn");
    expect(keysSent(), "繋ぎ直している間に送った").toEqual([]);
  });

  it("2 回目以降は回数を添える", async () => {
    const s = await open();
    clients[0]!.handlers.onServerMessage({ type: "host-reconnecting", attempt: 3, reason: "x" });
    expect(s.notice).toBe(msgHostReconnecting(3));
    expect(s.notice).toContain("3 回目");
  });

  it("**溜めた先打ちを捨てる**", async () => {
    const s = await open();
    s.typeAhead = [{ key: "A", code: "KeyA", shiftKey: false, ctrlKey: false, altKey: false, metaKey: false }];
    clients[0]!.handlers.onServerMessage({ type: "host-reconnecting", attempt: 1, reason: "x" });
    expect(s.typeAhead).toBeUndefined();
  });

  it("**繋ぎ直せたら通知を消し、送れる状態に戻る**", async () => {
    const s = await open();
    clients[0]!.handlers.onServerMessage({ type: "host-reconnecting", attempt: 2, reason: "x" });
    // **実際の順序**: 新しい接続の画面が先に届き、`host-reconnected` はその後（実機の ws ログ）
    clients[0]!.handlers.onServerMessage({ type: "screen", screen: snap(false) });
    clients[0]!.handlers.onServerMessage({ type: "host-reconnected" });
    expect(s.hostReconnect).toBeUndefined();
    expect(s.notice).toBeUndefined();
    sendKey("s1", "Enter");
    expect(keysSent().map((m) => m.key)).toEqual(["Enter"]);
  });

  it("ブラウザとサーバーの接続（link）は「繋がっている」のまま（別の状態）", async () => {
    const s = await open();
    clients[0]!.handlers.onServerMessage({ type: "host-reconnecting", attempt: 1, reason: "x" });
    expect(s.connected).toBe(true);
  });
});
