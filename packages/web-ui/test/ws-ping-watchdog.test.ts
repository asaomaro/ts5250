/**
 * 半開きの見張り（`20260908-session-survives-disconnect` decisions D6）。
 *
 * サーバーは 30 秒ごとに `ping` を送り、90 秒無応答でクライアントを畳む。**こちら側には
 * 対応する見張りが無かった**ので、`close` イベントが飛ばない切れ方（TCP は死んでいるのに
 * ブラウザが気づかない）では応答待ちの表示が永久に残っていた。
 *
 * 要点は 2 つ:
 *   - **`ping` が途絶えたら自分から畳む**（あとは既存の切断経路に合流させる）
 *   - **最初の `ping` を受け取るまで張らない**（`ping` を送らないサーバーと繋いだときに
 *     こちらが勝手に切らない＝後方互換）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WsClient } from "../src/ws-client.js";
import { logStore } from "../src/stores/log.js";

/** 手で開閉・受信させられる最小の WebSocket 代役（`ws-heartbeat.test.ts` と同じ形） */
class FakeSocket {
  static OPEN = 1;
  readyState = 1;
  sent: string[] = [];
  closed = 0;
  private listeners = new Map<string, ((ev: unknown) => void)[]>();
  addEventListener(type: string, fn: (ev: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  /** **`close` イベントは自動で飛ばさない**——半開きで飛ばないことを再現するため */
  close(): void {
    this.closed += 1;
    this.readyState = 3;
  }
  fire(type: string, ev: unknown): void {
    for (const fn of this.listeners.get(type) ?? []) fn(ev);
  }
  deliver(msg: unknown): void {
    this.fire("message", { data: JSON.stringify(msg) });
  }
}

let socket: FakeSocket;
const original = globalThis.WebSocket;

async function connect(onClose?: () => void): Promise<WsClient> {
  const client = new WsClient(
    "ws://x/ws",
    { onServerMessage: () => {}, ...(onClose ? { onClose } : {}) },
    "sess"
  );
  const p = client.connect();
  socket.fire("open", {});
  await p;
  return client;
}

describe("`ping` の見張り（半開きの検知）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    socket = new FakeSocket();
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = class {
      static OPEN = 1;
      constructor() {
        return socket as unknown as WebSocket;
      }
    };
    logStore.clear();
  });
  afterEach(() => {
    vi.useRealTimers();
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = original;
  });

  it("**`ping` が 90 秒来なければ自分から畳む**", async () => {
    await connect(() => {});
    socket.deliver({ type: "ping" });

    vi.advanceTimersByTime(90_000);

    expect(socket.closed).toBe(1);
  });

  it("`ping` が届いているあいだは畳まない（受けるたびに張り直す）", async () => {
    await connect(() => {});
    for (let i = 0; i < 5; i++) {
      socket.deliver({ type: "ping" });
      vi.advanceTimersByTime(30_000); // サーバーの心拍間隔
    }
    expect(socket.closed).toBe(0);
  });

  it("**最初の `ping` を受け取るまで張らない**（`ping` を送らないサーバーを切らない）", async () => {
    await connect(() => {});

    vi.advanceTimersByTime(10 * 60_000);

    expect(socket.closed).toBe(0);
  });

  it("**`onClose` を渡していない相手は見張らない**（監視コンソールを黙って切らない）", async () => {
    await connect(); // onClose なし
    socket.deliver({ type: "ping" });

    vi.advanceTimersByTime(90_000);

    expect(socket.closed).toBe(0);
  });

  it("**`close` イベントが来なくても切断として扱う**（半開きでは飛ばないことがある）", async () => {
    let closed = 0;
    await connect(() => closed++);
    socket.deliver({ type: "ping" });

    vi.advanceTimersByTime(90_000);
    expect(closed).toBe(0); // まだイベント待ち
    vi.advanceTimersByTime(3_000); // 保険の猶予

    expect(closed).toBe(1);
  });

  it("`close` イベントが来た場合、保険と二重に流さない", async () => {
    let closed = 0;
    await connect(() => closed++);
    socket.deliver({ type: "ping" });

    vi.advanceTimersByTime(90_000);
    socket.fire("close", {}); // 遅れてイベントが飛んできた
    vi.advanceTimersByTime(3_000);

    expect(closed).toBe(1);
  });
});
