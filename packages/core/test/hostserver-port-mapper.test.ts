import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:net";
import {
  resolveServicePort,
  SERVICE_NAME,
  DEFAULT_PORT,
  PORT_MAPPER_PORT
} from "../src/hostserver/port-mapper.js";
import { Tn5250Error } from "../src/errors.js";

/** 実機の 449 に依存しないよう、偽ポートマッパーを立てて mapperPort で差し向ける */
let server: Server | undefined;
afterEach(async () => {
  if (server) {
    await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
  }
});

/** 指定の応答を返す偽ポートマッパーを立て、そのポートを返す */
function fakeMapper(respond: (received: string) => Buffer | undefined): Promise<number> {
  return new Promise((resolve) => {
    server = createServer((sock) => {
      sock.once("data", (d) => {
        const reply = respond(d.toString("latin1"));
        if (reply) sock.write(reply);
        sock.end();
      });
    });
    server.listen(0, "127.0.0.1", () => {
      resolve((server!.address() as { port: number }).port);
    });
  });
}

const resolveOn = (port: number, service: Parameters<typeof resolveServicePort>[1]) =>
  resolveServicePort("127.0.0.1", service, { timeoutMs: 2000, mapperPort: port });

describe("SERVICE_NAME / DEFAULT_PORT", () => {
  it("ポートマッパーに渡すサービス名", () => {
    expect(SERVICE_NAME.signon).toBe("as-signon");
    expect(SERVICE_NAME.database).toBe("as-database");
    expect(SERVICE_NAME.ddm).toBe("drda");
  });

  it("既定ポートは平文と TLS で対になっている", () => {
    expect(DEFAULT_PORT.signon).toEqual({ plain: 8476, tls: 9476 });
    expect(DEFAULT_PORT.database).toEqual({ plain: 8471, tls: 9471 });
  });

  it("ポートマッパーは 449", () => {
    expect(PORT_MAPPER_PORT).toBe(449);
  });
});

describe("resolveServicePort（偽ポートマッパー）", () => {
  it("0x2B + 4 バイトのポートを解釈する", async () => {
    const port = await fakeMapper(() => {
      const b = Buffer.alloc(5);
      b[0] = 0x2b;
      b.writeUInt32BE(8476, 1);
      return b;
    });
    await expect(resolveOn(port, "signon")).resolves.toBe(8476);
  });

  it("要求にサービス名をそのまま送る", async () => {
    let seen = "";
    const port = await fakeMapper((received) => {
      seen = received;
      const b = Buffer.alloc(5);
      b[0] = 0x2b;
      b.writeUInt32BE(8471, 1);
      return b;
    });
    await resolveOn(port, "database");
    expect(seen).toBe("as-database");
  });

  it("先頭が 0x2B 以外なら拒否する", async () => {
    const port = await fakeMapper(() => Buffer.from([0x00, 0, 0, 0, 0]));
    await expect(resolveOn(port, "signon")).rejects.toThrow(/rejected service/);
  });

  it("範囲外のポートを拒否する", async () => {
    const port = await fakeMapper(() => {
      const b = Buffer.alloc(5);
      b[0] = 0x2b;
      b.writeUInt32BE(70000, 1);
      return b;
    });
    await expect(resolveOn(port, "signon")).rejects.toThrow(/invalid port/);
  });

  it("応答が短いまま切断されたら拒否する", async () => {
    const port = await fakeMapper(() => Buffer.from([0x2b, 0x00]));
    await expect(resolveOn(port, "signon")).rejects.toThrow(/closed the connection/);
  });

  it("接続できなければ CONNECT_FAILED", async () => {
    const port = await fakeMapper(() => undefined);
    await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
    await expect(resolveOn(port, "signon")).rejects.toMatchObject({ code: "CONNECT_FAILED" });
  });

  it("エラーは Tn5250Error", async () => {
    const port = await fakeMapper(() => Buffer.from([0x00, 0, 0, 0, 0]));
    await expect(resolveOn(port, "signon")).rejects.toBeInstanceOf(Tn5250Error);
  });
});

describe("TLS のサービス名", () => {
  it('tls 指定でサービス名に "-s" を付ける（実機: as-signon-s -> 9476）', async () => {
    let seen = "";
    const port = await fakeMapper((received) => {
      seen = received;
      const b = Buffer.alloc(5);
      b[0] = 0x2b;
      b.writeUInt32BE(9476, 1);
      return b;
    });
    const got = await resolveServicePort("127.0.0.1", "signon", {
      timeoutMs: 2000,
      mapperPort: port,
      tls: true
    });
    expect(seen).toBe("as-signon-s");
    expect(got).toBe(9476);
  });

  it("tls 未指定なら素のサービス名", async () => {
    let seen = "";
    const port = await fakeMapper((received) => {
      seen = received;
      const b = Buffer.alloc(5);
      b[0] = 0x2b;
      b.writeUInt32BE(8476, 1);
      return b;
    });
    await resolveServicePort("127.0.0.1", "signon", { timeoutMs: 2000, mapperPort: port });
    expect(seen).toBe("as-signon");
  });

  it("DDM は 8471 系ではなく DRDA 標準ポート（実機: drda -> 446）", () => {
    expect(DEFAULT_PORT.ddm).toEqual({ plain: 446, tls: 448 });
  });
});
