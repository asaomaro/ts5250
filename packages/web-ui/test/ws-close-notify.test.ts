/**
 * **WebSocket が閉じたことを上へ伝える**（実機報告: ローディングが解除されない）。
 *
 * `close` を操作ログに書くだけでは、`session-controller` は待ちを解けない
 * （`disconnect-clears-busy.test.ts` を参照）。開く前に閉じた場合も同じで、
 * `connect()` を落とさないと「開いています」の await が永遠に返らない。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { WsClient } from "../src/ws-client.js";
import { logStore } from "../src/stores/log.js";

/** 手で開閉させられる最小の WebSocket 代役（`ws-heartbeat.test.ts` と同じ形） */
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
}

let socket: FakeSocket;
const original = globalThis.WebSocket;

describe("WsClient の切断通知", () => {
  beforeEach(() => {
    socket = new FakeSocket();
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = class {
      static OPEN = 1;
      constructor() {
        return socket as unknown as WebSocket;
      }
    };
    logStore.clear();
    logStore.enabled = true; // 既定は無効（性能対策）。ログ内容そのものを検証するテストなので有効化する
  });
  afterEach(() => {
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = original;
    logStore.enabled = false;
  });

  it("閉じたら onClose を呼ぶ", async () => {
    let closed = 0;
    const client = new WsClient("ws://x/ws", { onServerMessage: () => {}, onClose: () => closed++ }, "sess");
    const p = client.connect();
    socket.fire("open", {});
    await p;

    socket.fire("close", {});

    expect(closed).toBe(1);
  });

  it("開く前に閉じたら connect() が落ちる（await が返らないのを防ぐ）", async () => {
    const client = new WsClient("ws://x/ws", { onServerMessage: () => {} }, "sess");
    const p = client.connect();

    socket.fire("close", {});

    await expect(p).rejects.toThrow();
  });

  it("開いた後の切断は connect() の結果を覆さない", async () => {
    const client = new WsClient("ws://x/ws", { onServerMessage: () => {} }, "sess");
    const p = client.connect();
    socket.fire("open", {});
    await expect(p).resolves.toBeUndefined();

    // 解決済みの Promise への reject は無視される（未処理の rejection を作らない）
    expect(() => socket.fire("close", {})).not.toThrow();
  });

  it("切断は操作ログに残る（実機で最後の 1 行になる）", async () => {
    const client = new WsClient("ws://x/ws", { onServerMessage: () => {} }, "sess");
    const p = client.connect();
    socket.fire("open", {});
    await p;

    socket.fire("close", {});

    expect(logStore.entries.at(-1)).toMatchObject({ dir: "event", kind: "closed" });
  });
});
