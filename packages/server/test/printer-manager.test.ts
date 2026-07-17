import { describe, it, expect } from "vitest";
import { SessionManager } from "../src/session-manager.js";
import type { Transport } from "@as400web/core";

/** startup + 印刷データ + Job Complete を IAC EOR 付きで供給できる最小 Transport */
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
function startup(code: number[]): number[] {
  const body = [0x12, 0xa0, 0x90, 0x00, 0x04, 0x00, 0x00, 0x00, 0, 0, 0, 0, 0, ...code];
  const ll = body.length + 2;
  return [(ll >> 8) & 0xff, ll & 0xff, ...body];
}
function data(scs: number[]): number[] {
  const body = [0x12, 0xa0, 0x01, 0x01, 0x04, 0x00, 0x00, 0x01, ...scs];
  const ll = body.length + 2;
  return [(ll >> 8) & 0xff, ll & 0xff, ...body];
}
const jobComplete = (): number[] => [0x00, 0x11, 0x12, 0xa0, 0x01, 0x01, 0x04, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0, 0];

describe("SessionManager プリンター", () => {
  it("openPrinter → 受信スプールを waitSpool で取得できる", async () => {
    const mgr = new SessionManager();
    let transport!: FakeTransport;
    const entry = await mgr.openPrinter({
      transport: new FakeTransport((t) => {
        transport = t;
        t.feed(startup(I902));
      })
    });
    expect(mgr.size).toBe(1);
    expect(entry.session.startupCode).toBe("I902");

    // まだ来ていないので wait を仕掛け、直後にスプールを流す
    const p = mgr.waitSpool(entry.id, 5000);
    transport.feed(data([0xc1, 0xc2])); // EBCDIC "AB"
    transport.feed(jobComplete());
    const report = await p;
    expect(report).toBeDefined();
    expect(report!.pages[0]!.lines[0]).toBe("AB");
    mgr.closeAll();
  });

  it("waitSpool はタイムアウトで undefined を返す", async () => {
    const mgr = new SessionManager();
    const entry = await mgr.openPrinter({
      transport: new FakeTransport((t) => t.feed(startup(I902)))
    });
    const report = await mgr.waitSpool(entry.id, 30);
    expect(report).toBeUndefined();
    mgr.closeAll();
  });
});
