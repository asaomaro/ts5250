import { describe, it, expect } from "vitest";
import { buildApp } from "../src/app.js";
import { SessionManager } from "../src/session-manager.js";
import { ProfileStore } from "../src/profiles.js";
import type { Transport } from "@as400web/core";

class FakeTransport implements Transport {
  private dataFn: ((d: Uint8Array) => void) | undefined;
  constructor(private readonly onStart: (t: FakeTransport) => void) {}
  send(): void {}
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
}
const I902 = [0xc9, 0xf9, 0xf0, 0xf2];
const startup = (): number[] => {
  const body = [0x12, 0xa0, 0x90, 0x00, 0x04, 0x00, 0x00, 0x00, 0, 0, 0, 0, 0, ...I902];
  const ll = body.length + 2;
  return [(ll >> 8) & 0xff, ll & 0xff, ...body];
};
const data = (scs: number[]): number[] => {
  const body = [0x12, 0xa0, 0x01, 0x01, 0x04, 0x00, 0x00, 0x01, ...scs];
  const ll = body.length + 2;
  return [(ll >> 8) & 0xff, ll & 0xff, ...body];
};
const jobComplete = (): number[] => [0x00, 0x11, 0x12, 0xa0, 0x01, 0x01, 0x04, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0, 0];

describe("GET /api/spool/:sessionId/:spoolId/pdf", () => {
  it("受信済みスプールを PDF で返す", async () => {
    const sessions = new SessionManager();
    const app = buildApp({ sessions, profiles: new ProfileStore([]), version: "1.0.0" });
    let transport!: FakeTransport;
    const entry = await sessions.openPrinter({
      transport: new FakeTransport((t) => {
        transport = t;
        t.feed(startup());
      })
    });
    transport.feed(data([0xc1, 0xc2])); // "AB"
    transport.feed(jobComplete());

    const res = await app.request(`/api/spool/${entry.id}/spool-1/pdf`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    sessions.closeAll();
  });

  it("存在しないスプールは 404", async () => {
    const sessions = new SessionManager();
    const app = buildApp({ sessions, profiles: new ProfileStore([]), version: "1.0.0" });
    await sessions.openPrinter({ transport: new FakeTransport((t) => t.feed(startup())) });
    const res = await app.request(`/api/spool/prt-x/nope/pdf`);
    expect(res.status).toBe(404);
    sessions.closeAll();
  });
});
