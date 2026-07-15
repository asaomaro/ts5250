import { describe, it, expect } from "vitest";
import { createServer, type Server, type Socket } from "node:net";
import { once } from "node:events";
import { TcpTransport } from "../src/transport/tcp.js";
import { Tn5250Error } from "../src/errors.js";

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
      (e: unknown) => e instanceof Tn5250Error && e.code === "CONNECT_FAILED"
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
      expect(() => t.send(Uint8Array.from([1]))).toThrow(Tn5250Error);
    });
  });
});
