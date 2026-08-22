import { describe, it, expect } from "vitest";
import { createServer, type Server } from "node:tls";
import { once } from "node:events";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TcpTransport } from "../src/transport/tcp.js";
import { As400Error } from "@ts5250/base";

/**
 * 自己署名証明書を openssl で生成（テスト用）。
 *
 * **一時ディレクトリーは Node で作る。** 以前は `mktemp -d` を呼んでいたが、
 * Windows では Git 同梱の `mktemp` が **MSYS のパス**（`/tmp/tmp.xxxx`）を返し、
 * Node からは `C:\tmp\…` として解決されて読み書きできない（実測で 3 件が落ちた）。
 * `mkdtempSync` なら OS の作法どおりのパスになる。
 */
function selfSigned(): { key: string; cert: string } {
  const dir = mkdtempSync(join(tmpdir(), "tn5250-tls-"));
  const key = join(dir, "k.pem");
  const cert = join(dir, "c.pem");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", key, "-out", cert,
    "-days", "1", "-subj", "/CN=localhost"
  ]);
  return { key: readFileSync(key, "utf8"), cert: readFileSync(cert, "utf8") };
}

/**
 * `openssl` が使えるか。**ENOENT だけを「未インストール」と見る**
 * （`zip-writer.test.ts` と同じ考え方。無い環境では「TLS が壊れた」ではなく
 * 「検証手段が無い」が正しい）。飛ばした事実は vitest の skip として残る。
 */
const HAS_OPENSSL =
  (spawnSync("openssl", ["version"], { stdio: "ignore" }).error as NodeJS.ErrnoException | undefined)
    ?.code !== "ENOENT";

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

describe.skipIf(!HAS_OPENSSL)("TcpTransport TLS", () => {
  it("自己署名証明書は既定検証で TLS_CERT_INVALID", async () => {
    await withTlsServer(async (port) => {
      await expect(
        TcpTransport.connect({ host: "127.0.0.1", port, tls: true, connectTimeoutMs: 5000 })
      ).rejects.toSatisfy((e: unknown) => e instanceof As400Error && e.code === "TLS_CERT_INVALID");
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
