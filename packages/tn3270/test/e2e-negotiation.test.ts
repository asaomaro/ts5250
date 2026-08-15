import { describe, it, expect } from "vitest";
import { TcpTransport } from "../src/transport/tcp.js";
import { TelnetLayer } from "../src/telnet/telnet.js";
import { terminalTypeFor } from "../src/telnet/terminal-type.js";

/**
 * **実ホスト（TK4- / MVS 3.8j）との照合。**
 *
 * docker が要るので **既定では走らせない**（design D10 の 2 段テスト）。
 * 有効化するには環境を上げてから環境変数を付ける:
 *
 * ```sh
 * sh packages/tn3270/test/harness/testenv.sh up
 * TN3270_E2E=1 npx vitest run test/e2e-negotiation.test.ts
 * ```
 *
 * ここで確かめるのは **交渉が成立し、生の 3270 データストリームが届くこと**まで。
 * 中身の解釈は subtask 02 の担当。
 */

const enabled = process.env["TN3270_E2E"] === "1";
const host = process.env["TN3270_HOST"] ?? "127.0.0.1";
const port = Number(process.env["TN3270_PORT"] ?? 3270);

describe.skipIf(!enabled)("TK4- との telnet 交渉（実接続）", () => {
  it("交渉が成立し、最初のレコードが 3270 コマンドで始まる", async () => {
    const transport = await TcpTransport.connect({ host, port, connectTimeoutMs: 10_000 });
    try {
      const telnet = new TelnetLayer(transport, {
        terminalType: terminalTypeFor({ model: 2 })
      });

      const negotiated = new Promise<void>((resolve) => telnet.onNegotiated(resolve));
      const firstRecord = new Promise<Uint8Array>((resolve) => telnet.onRecord(resolve));

      await withTimeout(negotiated, 10_000, "交渉が終わらない");
      const record = await withTimeout(firstRecord, 10_000, "データストリームが来ない");

      // Hercules は Erase/Write(F5) か Write(F1) で最初の画面を送る（research F2 実測）
      expect(record.length).toBeGreaterThan(2);
      expect([0xf5, 0xf1, 0x7e]).toContain(record[0]);
    } finally {
      transport.close();
    }
  }, 30_000);

  it("TSO 端末（03C0）を装置指定で掴める", async () => {
    const transport = await TcpTransport.connect({ host, port, connectTimeoutMs: 10_000 });
    try {
      const telnet = new TelnetLayer(transport, {
        terminalType: terminalTypeFor({ model: 2, deviceName: "03C0" })
      });
      const negotiated = new Promise<void>((resolve) => telnet.onNegotiated(resolve));
      await withTimeout(negotiated, 10_000, "装置指定つきの交渉が終わらない");
      expect(true).toBe(true);
    } finally {
      transport.close();
    }
  }, 30_000);
});

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what}（${ms}ms）`)), ms))
  ]);
}
