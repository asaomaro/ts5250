import { describe, it, expect, vi, afterEach } from "vitest";
import { createServer, Socket, type Server } from "node:net";

/**
 * **ホストサーバーの接続も、TCP キープアライブは既定で入れない**（`20260930-hostserver-keepalive-off`）。ACS 同梱の `jt400` は既定で入れない
 * （`SocketProperties` の `keepAlive` は設定しなければ JVM の既定）。入れると一時的な回線断で無通信のあいだに探査が失敗して接続が落ちる（Windows は 10 秒ほど）。
 * 常駐の待ち受け（DTAQ の `wait=-1`・メッセージ待ち）が途中の機器に落とされる環境だけ、セッション設定 `keepAlive: true` で入れる
 */

// 各接続クラスは先に signon してから目的のサーバーを開く。**開く直前の受け渡し**を見るため、signon は成功させ、開く関数は渡された材料を記録して止める
const opened: { host: string; port: number; keepAlive?: boolean }[] = [];
vi.mock("../src/signon.js", async (orig) => ({
  ...(await orig<typeof import("../src/signon.js")>()),
  signon: vi.fn(async () => ({ info: { passwordLevel: 0 } }))
}));
vi.mock("../src/transport/host-connection.js", async (orig) => {
  const actual = await orig<typeof import("../src/transport/host-connection.js")>();
  return {
    ...actual,
    openHostConnection: vi.fn(async (o: { host: string; port: number; keepAlive?: boolean }) => {
      opened.push(o);
      throw new Error("stop before the server handshake");
    })
  };
});
vi.mock("../src/transport/ddm-transport.js", async (orig) => {
  const actual = await orig<typeof import("../src/transport/ddm-transport.js")>();
  return {
    ...actual,
    openDdmTransport: vi.fn(async (o: { host: string; port: number; keepAlive?: boolean }) => {
      opened.push(o);
      throw new Error("stop before the server handshake");
    })
  };
});

import { CommandConnection } from "../src/command/command-connection.js";
import { DbConnection } from "../src/db/db-connection.js";
import { IfsConnection } from "../src/ifs/ifs-connection.js";
import { NetPrintConnection } from "../src/spool/netprint-connection.js";
import { DtaqConnection } from "../src/dtaq/dtaq-connection.js";
import { DdmConnection } from "../src/ddm/ddm-connection.js";

const base = { host: "h", user: "u", password: "p", port: 1, resolvePort: false } as const;
const classes: [string, (o: Record<string, unknown>) => Promise<unknown>][] = [
  ["コマンド", (o) => CommandConnection.connect({ ...base, ...o })],
  ["データベース", (o) => DbConnection.connect({ ...base, ...o })],
  ["IFS", (o) => IfsConnection.connect({ ...base, ...o })],
  ["ネットワークプリント", (o) => NetPrintConnection.connect({ ...base, ...o })],
  ["データ待ち行列", (o) => DtaqConnection.connect({ ...base, ...o })],
  ["DDM", (o) => DdmConnection.connect({ ...base, ...o })]
];

describe("接続クラスの keepAlive の受け渡し", () => {
  for (const [name, connect] of classes) {
    it(`**${name}**: 指定すると開く関数へ届く`, async () => {
      opened.length = 0;
      await connect({ keepAlive: true }).catch(() => undefined);
      expect(opened.at(-1)?.keepAlive).toBe(true);
    });
    it(`${name}: 指定しなければ載らない（既定は入れない）`, async () => {
      opened.length = 0;
      await connect({}).catch(() => undefined);
      expect(opened.length).toBe(1);
      expect("keepAlive" in (opened.at(-1) ?? {})).toBe(false);
    });
  }
});

describe("トランスポートの keepAlive", () => {
  let server: Server | undefined;
  const sockets = new Set<Socket>();
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const s of sockets) s.destroy();
    sockets.clear();
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    server = undefined;
  });
  const listen = async (): Promise<number> => {
    server = createServer((s) => {
      sockets.add(s);
      s.on("error", () => {});
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
    return (server!.address() as { port: number }).port;
  };

  it("**host-connection: 既定は入れない・`keepAlive: true` で入れる**", async () => {
    const { openHostConnection } = await vi.importActual<typeof import("../src/transport/host-connection.js")>("../src/transport/host-connection.js");
    const port = await listen();
    const spy = vi.spyOn(Socket.prototype, "setKeepAlive");
    const a = await openHostConnection({ host: "127.0.0.1", port });
    expect(spy).not.toHaveBeenCalled();
    a.close();
    const b = await openHostConnection({ host: "127.0.0.1", port, keepAlive: true });
    expect(spy).toHaveBeenCalledWith(true, 60_000);
    b.close();
  });

  it("**ddm-transport: 既定は入れない・`keepAlive: true` で入れる**", async () => {
    const { openDdmTransport } = await vi.importActual<typeof import("../src/transport/ddm-transport.js")>("../src/transport/ddm-transport.js");
    const port = await listen();
    const spy = vi.spyOn(Socket.prototype, "setKeepAlive");
    const a = await openDdmTransport({ host: "127.0.0.1", port });
    expect(spy).not.toHaveBeenCalled();
    a.close();
    const b = await openDdmTransport({ host: "127.0.0.1", port, keepAlive: true });
    expect(spy).toHaveBeenCalledWith(true, 60_000);
    b.close();
  });
});
