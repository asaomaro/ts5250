import { describe, it, expect } from "vitest";
import { createServer, type Server } from "node:tls";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { TcpTransport } from "../src/transport/tcp.js";
import { Tn5250Error } from "../src/errors.js";

/** 自己署名証明書を openssl で生成（テスト用） */
function selfSigned(): { key: string; cert: string } {
  const dir = execFileSync("mktemp", ["-d"]).toString().trim();
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", `${dir}/k.pem`, "-out", `${dir}/c.pem`,
    "-days", "1", "-subj", "/CN=localhost"
  ]);
  return { key: readFileSync(`${dir}/k.pem`, "utf8"), cert: readFileSync(`${dir}/c.pem`, "utf8") };
}

async function withTlsServer(fn: (port: number, cert: string) => Promise<void>): Promise<void> {
  const { key, cert } = selfSigned();
  const server: Server = createServer({ key, cert }, (s) => s.on("data", (d) => s.write(d)));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  try {
    await fn(addr.port, cert);
  } finally {
    server.close();
  }
}

describe("TcpTransport TLS", () => {
  it("自己署名証明書は既定検証で TLS_CERT_INVALID", async () => {
    await withTlsServer(async (port) => {
      await expect(
        TcpTransport.connect({ host: "127.0.0.1", port, tls: true, connectTimeoutMs: 5000 })
      ).rejects.toSatisfy((e: unknown) => e instanceof Tn5250Error && e.code === "TLS_CERT_INVALID");
    });
  });

  it("rejectUnauthorized:false で接続できる", async () => {
    await withTlsServer(async (port) => {
      const t = await TcpTransport.connect({
        host: "127.0.0.1",
        port,
        tls: { rejectUnauthorized: false },
        connectTimeoutMs: 5000
      });
      const got: number[] = [];
      const done = new Promise<void>((r) => t.onData((d) => { got.push(...d); if (got.length >= 2) r(); }));
      t.send(Uint8Array.from([1, 2]));
      await done;
      expect(got).toEqual([1, 2]);
      t.close();
    });
  });

  it("ca 指定で自己署名を信頼して接続できる", async () => {
    // cert の CN=localhost に合わせて localhost で接続（altname 一致）
    await withTlsServer(async (port, cert) => {
      const t = await TcpTransport.connect({
        host: "localhost",
        port,
        tls: { ca: cert },
        connectTimeoutMs: 5000
      });
      expect(t).toBeDefined();
      t.close();
    });
  });
});
