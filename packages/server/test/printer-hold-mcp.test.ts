import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../src/mcp-server.js";
import { SessionManager } from "../src/session-manager.js";
import { ConfigResolver } from "../src/config-resolver.js";
import { ServerConfigStore, PersonalConfigStore } from "../src/config-store.js";
import type { Transport } from "@ts5250/tn5250";

/**
 * **MCP から止めている帳票が見え、再試行・取消できる**（`20260921-printer-hold-response` の独立点検の指摘）。
 * MCP で開いたプリンターは画面から開き直せない（`ref` を持たない）ので、MCP に手段が無いと抜けられなかった。
 * 止めている間ホストは次を送らないので、`wait_spool` は理由なく時間切れを返し続けていた。
 */
class FakeTransport implements Transport {
  private dataFn: ((d: Uint8Array) => void) | undefined;
  readonly sent: Uint8Array[] = [];
  constructor(private readonly onStart: (t: FakeTransport) => void) {}
  send(d: Uint8Array): void {
    this.sent.push(d);
  }
  close(): void {}
  onData(fn: (d: Uint8Array) => void): void {
    this.dataFn = fn;
  }
  onClose(): void {}
  onError(): void {}
  start(): void {
    this.onStart(this);
  }
  feed(rec: number[]): void {
    const out: number[] = [];
    for (const b of rec) {
      out.push(b);
      if (b === 0xff) out.push(0xff);
    }
    out.push(0xff, 0xef);
    this.dataFn?.(Uint8Array.from(out));
  }
  noErrors(): number {
    return this.sent.filter((d) => d.length >= 10 && d[1] === 0x0a && d[9] === 0x01 && d[2] === 0x12).length;
  }
}
const startup = (): number[] => {
  const body = [0x12, 0xa0, 0x90, 0x00, 0x04, 0x00, 0x00, 0x00, 0, 0, 0, 0, 0, 0xc9, 0xf9, 0xf0, 0xf2];
  return [0x00, body.length + 2, ...body];
};
const data = (scs: number[]): number[] => {
  const body = [0x12, 0xa0, 0x01, 0x01, 0x04, 0x00, 0x00, 0x01, ...scs];
  return [0x00, body.length + 2, ...body];
};
const jobComplete = (): number[] => [0x00, 0x11, 0x12, 0xa0, 0x01, 0x01, 0x0a, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0, 0];
async function waitFor(cond: () => boolean, ms = 4000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms && !cond()) await new Promise((r) => setTimeout(r, 25));
  return cond();
}

async function setup() {
  const sessions = new SessionManager();
  let t!: FakeTransport;
  const entry = await sessions.openPrinter({
    output: { autoPdfDir: join(mkdtempSync(join(tmpdir(), "phold-mcp-")), "not-yet") },
    transport: new FakeTransport((tr) => {
      t = tr;
      tr.feed(startup());
    })
  });
  const server = buildMcpServer({
    sessions,
    resolver: new ConfigResolver(new ServerConfigStore(), new PersonalConfigStore()),
    version: "test"
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" }, { capabilities: {} });
  await Promise.all([server.connect(b), client.connect(a)]);
  const call = async (name: string, args: Record<string, unknown>) =>
    (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content?: { text: string }[];
      structuredContent?: Record<string, unknown>;
    };
  return { sessions, entry, t: () => t, call };
}

describe("MCP: 止めている帳票", () => {
  it("wait_spool の時間切れと list_spools に `held`（帳票と理由）が入る", async () => {
    const { entry, t, call } = await setup();
    t().feed(data([0xc8, 0xc9]));
    t().feed(jobComplete());
    await waitFor(() => entry.heldOutput !== undefined);
    await call("wait_spool", { sessionId: entry.id, timeoutMs: 10 }); // 届いた 1 件目を受け取る
    const r = await call("wait_spool", { sessionId: entry.id, timeoutMs: 10 });
    expect(r.structuredContent).toMatchObject({ received: false, held: { spoolId: "spool-1" } });
    expect(r.content?.[0]?.text).toMatch(/retry_printer_output/);
    const l = await call("list_spools", { sessionId: entry.id });
    expect(l.structuredContent).toMatchObject({ held: { spoolId: "spool-1" } });
    expect(String((l.structuredContent?.held as { error: string }).error)).toMatch(/PDF/);
  });

  it("cancel_printer_output で応答する。止めている帳票が無ければエラー", async () => {
    const { entry, t, call } = await setup();
    t().feed(data([0xc8, 0xc9]));
    t().feed(jobComplete());
    await waitFor(() => entry.heldOutput !== undefined);
    const c = await call("cancel_printer_output", { sessionId: entry.id });
    expect(c.isError).toBeFalsy();
    expect(c.structuredContent).toMatchObject({ spoolId: "spool-1" });
    expect(await waitFor(() => t().noErrors() === 2)).toBe(true);
    const again = await call("retry_printer_output", { sessionId: entry.id });
    expect(again.isError).toBe(true);
  });

  it("retry_printer_output はやり直す（また失敗すれば止めたまま）", async () => {
    const { entry, t, call } = await setup();
    t().feed(data([0xc8, 0xc9]));
    t().feed(jobComplete());
    await waitFor(() => entry.heldOutput !== undefined);
    const n = entry.outputStatuses.length;
    const r = await call("retry_printer_output", { sessionId: entry.id });
    expect(r.isError).toBeFalsy();
    expect(await waitFor(() => entry.outputStatuses.length > n && entry.heldOutput !== undefined)).toBe(true);
    expect(t().noErrors()).toBe(1);
  });
});
