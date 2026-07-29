/**
 * ハートビートの自動応答と、心拍・在席合図を操作ログに出さないこと。
 *
 * `ping` に `pong` を返さないとサーバーが半開きと判断してセッションを畳む
 * （`20260729-session-lifetime-timeout`）。逆に 15〜30 秒ごとの往復を操作ログへ出すと、
 * 利用者が読むログが心拍で埋まって使えなくなる。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WsClient } from "../src/ws-client.js";
import { logStore } from "../src/stores/log.js";

/** 手で開閉・受信させられる最小の WebSocket 代役 */
class FakeSocket {
  static OPEN = 1;
  readyState = 1;
  sent: string[] = [];
  private listeners = new Map<string, ((ev: unknown) => void)[]>();
  addEventListener(type: string, fn: (ev: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
  }
  fire(type: string, ev: unknown): void {
    for (const fn of this.listeners.get(type) ?? []) fn(ev);
  }
  /** サーバーからのメッセージを流す */
  deliver(msg: unknown): void {
    this.fire("message", { data: JSON.stringify(msg) });
  }
}

let socket: FakeSocket;
const original = globalThis.WebSocket;

async function connect(): Promise<WsClient> {
  const received: unknown[] = [];
  const client = new WsClient("ws://x/ws", { onServerMessage: (m) => received.push(m) }, "sess");
  const p = client.connect();
  socket.fire("open", {});
  await p;
  (client as unknown as { received: unknown[] }).received = received;
  return client;
}

describe("WsClient のハートビート", () => {
  beforeEach(() => {
    socket = new FakeSocket();
    // WebSocket は new されるので、コンストラクタごと差し替える
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = class {
      static OPEN = 1;
      constructor() {
        return socket as unknown as WebSocket;
      }
    };
    logStore.clear();
  });
  afterEach(() => {
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = original;
    vi.restoreAllMocks();
  });

  it("ping に pong を返す", async () => {
    await connect();
    socket.deliver({ type: "ping" });
    expect(socket.sent.map((s) => JSON.parse(s))).toEqual([{ type: "pong" }]);
  });

  it("ping は上（session-controller）へ渡さない", async () => {
    const client = await connect();
    socket.deliver({ type: "ping" });
    expect((client as unknown as { received: unknown[] }).received).toEqual([]);
  });

  it("ping / pong は操作ログに残らない", async () => {
    await connect();
    socket.deliver({ type: "ping" });
    expect(logStore.entries.filter((e) => e.kind === "ping" || e.kind === "pong")).toEqual([]);
  });

  it("activity も操作ログに残らない（15 秒ごとに流れるため）", async () => {
    const client = await connect();
    client.send({ type: "activity" });
    expect(socket.sent.map((s) => JSON.parse(s))).toEqual([{ type: "activity" }]);
    expect(logStore.entries.filter((e) => e.kind === "activity")).toEqual([]);
  });

  it("通常のメッセージは今までどおりログに残る（静かにするのは心拍だけ）", async () => {
    await connect();
    socket.deliver({ type: "screen", screen: { fields: [] } });
    expect(logStore.entries.some((e) => e.kind === "screen")).toBe(true);
  });
});
