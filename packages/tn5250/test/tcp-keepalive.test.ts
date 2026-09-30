import { describe, it, expect, vi, afterEach } from "vitest";
import { createServer, Socket, type Server } from "node:net";
import { TcpTransport } from "../src/transport/tcp.js";
import { Session5250 } from "../src/session/session.js";
import { PrinterSession } from "../src/session/printer-session.js";

/**
 * **TCP キープアライブは 5250 の表示セッションでは既定で入れない**（`20260930-display-keepalive-off`）。ACS は既定で入れない（`SESSION_KEEPALIVE` の既定は false）。
 * 入れると、一時的な回線断（LAN ケーブルの抜き差し）で無通信のあいだに探査が失敗して接続が落ちる——Windows の Node は無通信 60 秒のあと
 * 1 秒間隔で 10 回探査するので 10 秒ほどで落ち、ホストにはジョブと装置が使用中のまま残って繋ぎ直しも断られた。
 * **プリンターも同じ**（`20260930-printer-keepalive-off`）: ACS はプリンターも端末と同じ設定 `SESSION_KEEPALIVE`（既定 false）。常駐プリンターが途中の機器に
 * 無通信の接続を落とされる環境（15 分のアイドルで届かなくなる実測。`transport/tcp.ts`）は、設定 `keepAlive: true` で入れる。トランスポート自体の既定は入れる
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

describe("TcpTransport の keepAlive", () => {
  it("既定は入れる（プリンターなど、指定しない呼び出し側は今までどおり）", async () => {
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

describe("Session5250 の keepAlive（表示セッション）", () => {
  const open = async (keepAlive?: boolean): Promise<void> => {
    const port = await listen();
    await Session5250.connect({
      host: "127.0.0.1",
      port,
      negotiationTimeoutMs: 100,
      ...(keepAlive !== undefined ? { keepAlive } : {})
    }).catch(() => undefined);
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

describe("PrinterSession の keepAlive", () => {
  const open = async (keepAlive?: boolean): Promise<void> => {
    const port = await listen();
    await PrinterSession.connect({
      host: "127.0.0.1",
      port,
      negotiationTimeoutMs: 100,
      ...(keepAlive !== undefined ? { keepAlive } : {})
    }).catch(() => undefined);
  };

  it("**既定は入れない**（ACS はプリンターも入れない）", async () => {
    const spy = vi.spyOn(Socket.prototype, "setKeepAlive");
    await open();
    expect(spy).not.toHaveBeenCalled();
  });

  it("`keepAlive: true` なら入れる（常駐が途中の機器に落とされる環境向け）", async () => {
    const spy = vi.spyOn(Socket.prototype, "setKeepAlive");
    await open(true);
    expect(spy).toHaveBeenCalledWith(true, 60_000);
  });
});
