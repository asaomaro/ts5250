/**
 * MCP 経由のセッション寿命。
 *
 * **MCP には切断の通知が無い**（ツール呼び出しごとの HTTP）。ブラウザ経路は WS の切断と
 * ハートビートが孤児を回収するが、こちらには回収する者が居ないので、設定の「永続」を通すと
 * 落ちたクライアントのセッションが残り続け `maxSessions` を食い潰す（research F2）。
 *
 * ここで見るのは**配線**（`orphanSafeIdleTimeoutMs` を通しているか）。純関数側の判定は
 * `session-idle-timeout.test.ts` にある——素通しにしても純関数のテストは緑のままなので、
 * この配線を押さえないと元の穴が黙って残る。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ReplayTransport, parseTraceJsonl, type Transport } from "@as400web/core";
import { buildMcpServer } from "../src/mcp-server.js";
import {
  SessionManager,
  type OpenOptions,
  type OpenPrinterOptions
} from "../src/session-manager.js";
import { PersonalConfigStore } from "../src/config-store.js";
import { ConfigResolver } from "../src/config-resolver.js";
import type { IdleTimeout } from "../src/config-types.js";

const here = dirname(fileURLToPath(import.meta.url));
const signon = () =>
  parseTraceJsonl(
    readFileSync(join(here, "..", "..", "core", "test", "fixtures", "pub400-signon.jsonl"), "utf8")
  );

/** startup だけ返す最小のプリンター transport */
class PrinterTransport implements Transport {
  private dataFn: ((d: Uint8Array) => void) | undefined;
  send(): void {}
  close(): void {}
  onData(fn: (d: Uint8Array) => void): void {
    this.dataFn = fn;
  }
  onClose(): void {}
  onError(): void {}
  start(): void {
    const body = [0x12, 0xa0, 0x90, 0x00, 0x04, 0x00, 0x00, 0x00, 0, 0, 0, 0, 0, 0xc9, 0xf9, 0xf0, 0xf2];
    const ll = body.length + 2;
    this.dataFn?.(Uint8Array.from([(ll >> 8) & 0xff, ll & 0xff, ...body, 0xff, 0xef]));
  }
}

class SpyManager extends SessionManager {
  readonly openOpts: OpenOptions[] = [];
  readonly printerOpts: OpenPrinterOptions[] = [];
  override open(opts: OpenOptions) {
    this.openOpts.push(opts);
    return super.open({ ...opts, transport: new ReplayTransport(signon()) });
  }
  override openPrinter(opts: OpenPrinterOptions) {
    this.printerOpts.push(opts);
    return super.openPrinter({ ...opts, transport: new PrinterTransport() });
  }
}

async function openViaMcp(
  tool: "open_session" | "open_printer_session",
  ref: string,
  idleTimeout?: IdleTimeout
): Promise<SpyManager> {
  const sessions = new SpyManager();
  const personal = new PersonalConfigStore({
    systems: [{ id: "s", name: "s", host: "h", owner: "alice" }],
    sessions: [
      {
        id: "d",
        name: "d",
        system: "s",
        sessionType: "display",
        owner: "alice",
        ...(idleTimeout !== undefined ? { idleTimeout } : {})
      },
      {
        id: "p",
        name: "p",
        system: "s",
        sessionType: "printer",
        owner: "alice",
        ...(idleTimeout !== undefined ? { idleTimeout } : {})
      }
    ]
  });
  const server = buildMcpServer({
    sessions,
    resolver: new ConfigResolver(undefined, personal),
    version: "test"
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" }, { capabilities: {} });
  await Promise.all([server.connect(b), client.connect(a)]);
  await client.callTool({ name: tool, arguments: { session: ref } });
  sessions.closeAll();
  return sessions;
}

describe("MCP 経由の open_session", () => {
  it('設定が "never" でも有限値に落ちる（回収する者が居ないため）', async () => {
    const mgr = await openViaMcp("open_session", "own:d", "never");
    expect(mgr.openOpts[0]?.idleTimeoutMs).toBe(30 * 60_000);
  });

  it("設定の有限値はそのまま尊重する", async () => {
    const mgr = await openViaMcp("open_session", "own:d", 5);
    expect(mgr.openOpts[0]?.idleTimeoutMs).toBe(5 * 60_000);
  });

  it("設定が無ければ安全網の 30 分（従来の既定と同じ）", async () => {
    const mgr = await openViaMcp("open_session", "own:d");
    expect(mgr.openOpts[0]?.idleTimeoutMs).toBe(30 * 60_000);
  });
});

describe("MCP 経由の open_printer_session", () => {
  it('設定が "never" でも有限値に落ちる', async () => {
    const mgr = await openViaMcp("open_printer_session", "own:p", "never");
    expect(mgr.printerOpts[0]?.idleTimeoutMs).toBe(30 * 60_000);
  });

  it("設定の有限値はそのまま尊重する", async () => {
    const mgr = await openViaMcp("open_printer_session", "own:p", 5);
    expect(mgr.printerOpts[0]?.idleTimeoutMs).toBe(5 * 60_000);
  });
});
