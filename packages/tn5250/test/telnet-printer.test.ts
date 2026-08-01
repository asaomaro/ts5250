import { describe, it, expect } from "vitest";
import { TelnetLayer } from "../src/telnet/telnet.js";
import type { Transport } from "../src/transport/types.js";

class CaptureTransport implements Transport {
  sent: number[][] = [];
  private dataFn: ((d: Uint8Array) => void) | undefined;
  send(d: Uint8Array): void {
    this.sent.push([...d]);
  }
  close(): void {}
  onData(fn: (d: Uint8Array) => void): void {
    this.dataFn = fn;
  }
  onClose(): void {}
  onError(): void {}
  feed(bytes: number[]): void {
    this.dataFn?.(Uint8Array.from(bytes));
  }
}

const asciiOf = (bytes: number[]): string => String.fromCharCode(...bytes);

describe("TelnetLayer プリンター NEW-ENVIRON", () => {
  it("NEW-ENVIRON SEND に対し IBMFONT / IBMTRANSFORM を USERVAR で返す", () => {
    const t = new CaptureTransport();
    new TelnetLayer(t, {
      terminalType: "IBM-3812-1",
      deviceName: "PRT1",
      ibmFont: "12",
      ibmTransform: "0"
    });
    // IAC SB NEW_ENVIRON(39) SEND(1) IAC SE
    t.feed([0xff, 0xfa, 0x27, 0x01, 0xff, 0xf0]);
    const reply = t.sent.at(-1)!;
    const text = asciiOf(reply);
    expect(text).toContain("IBMFONT");
    expect(text).toContain("IBMTRANSFORM");
    expect(text).toContain("DEVNAME");
    expect(text).toContain("PRT1");
  });

  it("プリンター指定が無ければ IBMFONT/IBMTRANSFORM を送らない（表示セッションを汚さない）", () => {
    const t = new CaptureTransport();
    new TelnetLayer(t, { terminalType: "IBM-3179-2" });
    t.feed([0xff, 0xfa, 0x27, 0x01, 0xff, 0xf0]);
    const text = asciiOf(t.sent.at(-1)!);
    expect(text).not.toContain("IBMFONT");
    expect(text).not.toContain("IBMTRANSFORM");
  });
});
