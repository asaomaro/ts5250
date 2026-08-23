import { describe, it, expect } from "vitest";
import { createServer, type Server, type Socket } from "node:net";
import { once } from "node:events";
import { TcpTransport } from "../src/transport/tcp.js";
import { As400Error } from "@ts5250/base";

async function withEchoServer(fn: (port: number, server: Server) => Promise<void>): Promise<void> {
  const sockets = new Set<Socket>();
  const server = createServer((s) => {
    sockets.add(s);
    s.on("data", (d) => s.write(d));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  try {
    await fn(addr.port, server);
  } finally {
    for (const s of sockets) s.destroy();
    server.close();
  }
}

describe("TcpTransport", () => {
  it("接続してデータを送受信できる", async () => {
    await withEchoServer(async (port) => {
      const t = await TcpTransport.connect({ host: "127.0.0.1", port });
      const received: number[] = [];
      const done = new Promise<void>((resolve) => {
        t.onData((d) => {
          received.push(...d);
          if (received.length >= 3) resolve();
        });
      });
      t.send(Uint8Array.from([1, 2, 3]));
      await done;
      expect(received).toEqual([1, 2, 3]);
      t.close();
    });
  });

  it("接続拒否は CONNECT_FAILED", async () => {
    // 予約済みポートを確保してすぐ閉じ、接続拒否を誘発する
    const server = createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const addr = server.address();
    if (addr === null || typeof addr === "string") throw new Error("no port");
    const port = addr.port;
    server.close();
    await once(server, "close");

    await expect(TcpTransport.connect({ host: "127.0.0.1", port })).rejects.toSatisfy(
      (e: unknown) => e instanceof As400Error && e.code === "CONNECT_FAILED"
    );
  });

  it("相手方切断で onClose が 1 回だけ発火する", async () => {
    await withEchoServer(async (port, server) => {
      const t = await TcpTransport.connect({ host: "127.0.0.1", port });
      let closes = 0;
      const closed = new Promise<void>((resolve) => {
        t.onClose(() => {
          closes++;
          resolve();
        });
      });
      // サーバー側から全接続を切る
      server.close();
      await new Promise((r) => setTimeout(r, 10));
      t.close(); // 二重 close しても 1 回のみ
      await closed;
      expect(closes).toBe(1);
    });
  });

  it("close 後の send は SESSION_CLOSED", async () => {
    await withEchoServer(async (port) => {
      const t = await TcpTransport.connect({ host: "127.0.0.1", port });
      t.close();
      expect(() => t.send(Uint8Array.from([1]))).toThrow(As400Error);
    });
  });
});

/**
 * **キープアライブが実際に立つ**ことの確認（backlog `hostserver.md`）。
 *
 * 効果は**分単位の無通信でしか現れない**ので、外しても型検査もテストもビルドも通る
 * ——サイズも挙動も何も変わらず、誰も気づかないまま落ちる。
 *
 * ## なぜ要るのか（実機で測った）
 *
 * 2026-08-22・SR-OSAKA: **常駐プリンターは 15 分のアイドルで帳票が届かなくなる**。
 * そのとき `entry.state` は `listening` のままで、**こちら側からは何も見えない**。
 * ホスト側のライターは動いており（`状態=STR`）、**接続が黙って死んでいた**。
 * 同じ実機で待ち行列監視は 45 分を越えられており、あちらは
 * `hostserver` 側の接続で `setKeepAlive` が入っていた——入っていない方だけが落ちていた。
 *
 * ⚠ **`setKeepAlive` の状態は Node から読み出せない**ので、呼び出しを覗いて確かめる。
 */
describe("キープアライブ", () => {
  /** `Socket.prototype.setKeepAlive` を覗く。**実際の接続経路を通す**のが要点 */
  async function keepAliveArgsOf(connect: (port: number) => Promise<unknown>): Promise<unknown[][]> {
    const { Socket } = await import("node:net");
    const calls: unknown[][] = [];
    const original = Socket.prototype.setKeepAlive;
    Socket.prototype.setKeepAlive = function patched(...args: unknown[]) {
      calls.push(args);
      return (original as (...a: unknown[]) => unknown).apply(this, args) as never;
    } as typeof original;
    try {
      await withEchoServer(async (port) => {
        await connect(port);
      });
    } finally {
      Socket.prototype.setKeepAlive = original;
    }
    return calls;
  }

  it("**平文の接続でキープアライブを立てる**", async () => {
    const calls = await keepAliveArgsOf((port) =>
      TcpTransport.connect({ host: "127.0.0.1", port })
    );
    expect(calls.length, "setKeepAlive が呼ばれる").toBeGreaterThan(0);
    expect(calls[0]).toEqual([true, 60_000]);
  });

  it("**待ち時間はホストサーバー側と同じ 60 秒**（同じ性質の待ちを別の値にしない）", async () => {
    const calls = await keepAliveArgsOf((port) =>
      TcpTransport.connect({ host: "127.0.0.1", port })
    );
    for (const c of calls) expect(c[1]).toBe(60_000);
  });
});
