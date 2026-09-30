import { describe, it, expect, vi, afterEach } from "vitest";
import { createServer, Socket, type Server } from "node:net";
import { TcpTransport } from "../src/transport/tcp.js";
import { VtSession } from "../src/session/vt-session.js";

/**
 * **VT の表示セッションも、TCP キープアライブは既定で入れない**（`20260930-display-keepalive-off`）。ACS は端末の種類を問わず既定で入れない
 * （`SESSION_KEEPALIVE` の既定 false。5250・3270・VT は同じ `Terminal` の設定）。入れると一時的な回線断で無通信のあいだに探査が失敗して接続が落ちる。
 * トランスポート自体の既定（`keepAlive` を指定しない呼び出し）は入れる——常駐の用途に備えて従来どおり
 */
let server: Server | undefined;
const sockets = new Set<Socket>();
afterEach(async () => {
  vi.restoreAllMocks();
  for (const s of sockets) s.destroy(); // 開いたままの接続があると close が終わらない
  sockets.clear();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
});

async function listen(): Promise<number> {
  server = createServer((s) => {
    sockets.add(s);
    s.on("error", () => {});
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
  return (server!.address() as { port: number }).port;
}

describe("TcpTransport の keepAlive（VT）", () => {
  it("既定は入れる（指定しない呼び出しは従来どおり）", async () => {
    const port = await listen();
    const spy = vi.spyOn(Socket.prototype, "setKeepAlive");
    const t = await TcpTransport.connect({ host: "127.0.0.1", port });
    expect(spy).toHaveBeenCalledWith(true, 60_000);
    t.close();
  });

  it("`keepAlive: false` なら入れない", async () => {
    const port = await listen();
    const spy = vi.spyOn(Socket.prototype, "setKeepAlive");
    const t = await TcpTransport.connect({ host: "127.0.0.1", port, keepAlive: false });
    expect(spy).not.toHaveBeenCalled();
    t.close();
  });
});

describe("VT セッションの keepAlive", () => {
  const open = async (keepAlive?: boolean): Promise<void> => {
    const port = await listen();
    const s = await VtSession.connect({ host: "127.0.0.1", port, ...(keepAlive !== undefined ? { keepAlive } : {}) }).catch(() => undefined);
    s?.close?.();
  };

  it("**既定は入れない**（ACS と同じ）", async () => {
    const spy = vi.spyOn(Socket.prototype, "setKeepAlive");
    await open();
    expect(spy).not.toHaveBeenCalled();
  });

  it("`keepAlive: true` なら入れる（途中の機器が無通信の接続を落とす環境向け）", async () => {
    const spy = vi.spyOn(Socket.prototype, "setKeepAlive");
    await open(true);
    expect(spy).toHaveBeenCalledWith(true, 60_000);
  });
});
