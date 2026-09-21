import { describe, it, expect } from "vitest";
import { TelnetLayer } from "../src/telnet/telnet.js";
import { printerDeclaration } from "../src/session/terminal-type.js";
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

/**
 * **プリンターの申告は ACS と同じ組**（`20260921-printer-acs-declaration`。ACS `NVT5250` の
 * `userVarPRTDB` / `userVarPRTSB` / `userVarPRT?BHPT` と `insertVariable` の値）。
 * 日本語機では、この組なら装置が 5553 として作られ IGC の帳票が届き、当 PJ の旧い組では 3812 にされ CPA3303 だった。
 */
describe("プリンターの申告（ACS の組）", () => {
  const USERVAR = 3, VALUE = 1, ESC = 2;
  const uv = (name: string, value = ""): number[] => [USERVAR, ...[...name].map((c) => c.charCodeAt(0)), VALUE, ...[...value].map((c) => c.charCodeAt(0))];
  /** NEW-ENVIRON SEND に答えた SB の中身（IAC SB 39 IS … IAC SE の IS の後ろ） */
  function envReply(ccsid: number, transformTo?: string, deviceName = "PRT1"): number[] {
    const d = printerDeclaration(ccsid, transformTo);
    const t = new CaptureTransport();
    new TelnetLayer(t, { terminalType: d.terminalType, deviceName, userVars: d.userVars, sendConfRec: false });
    t.feed([0xff, 0xfa, 0x27, 0x01, 0xff, 0xf0]);
    const r = t.sent.at(-1)!;
    return r.slice(4, -2); // IAC SB 39 0 … IAC SE
  }

  it("**DBCS・HPT なし: IBM-5553-B01 と 6 変数**（KBDTYPE / CODEPAGE / CHARSET / IBMFONT / IBMSENDCONFREC は送らない）", () => {
    expect(printerDeclaration(5035).terminalType).toBe("IBM-5553-B01");
    expect(envReply(5035)).toEqual([
      ...uv("DEVNAME", "PRT1"),
      ...uv("IBMMSGQNAME", "QSYSOPR"),
      ...uv("IBMMSGQLIB", "*LIBL"),
      ...uv("IBMFORMFEED"),
      ...uv("IBMIGCFEAT", "2424J0"),
      ...uv("IBMTRANSFORM", "0")
    ]);
  });

  it("SBCS・HPT なし: IBM-3812-1 と ACS の 7 変数（フォント 11・バッファ 768）", () => {
    expect(printerDeclaration(37).terminalType).toBe("IBM-3812-1");
    expect(envReply(37)).toEqual([
      ...uv("DEVNAME", "PRT1"),
      ...uv("IBMMSGQNAME", "QSYSOPR"),
      ...uv("IBMMSGQLIB", "*LIBL"),
      ...uv("IBMFONT", "11"),
      ...uv("IBMFORMFEED"),
      ...uv("IBMBUFFERSIZE", "768"),
      ...uv("IBMTRANSFORM", "0")
    ]);
  });

  it("HPT（DBCS）: IBM-3812-1、用紙入れ・封筒は ESC＋0x00、IBMASCII899 は無い、機種名は `_` の手前まで", () => {
    expect(printerDeclaration(1399, "*HP4").terminalType).toBe("IBM-3812-1");
    expect(envReply(1399, "*HP4_X")).toEqual([
      ...uv("DEVNAME", "PRT1"),
      ...uv("IBMMSGQNAME", "QSYSOPR"),
      ...uv("IBMMSGQLIB", "*LIBL"),
      ...uv("IBMFONT", "11"),
      ...uv("IBMBUFFERSIZE", "768"),
      ...uv("IBMTRANSFORM", "1"),
      ...uv("IBMMFRTYPMDL", "*HP4"),
      ...uv("IBMPPRSRC1"), ESC, 0x00,
      ...uv("IBMPPRSRC2"), ESC, 0x00,
      ...uv("IBMENVELOPE"), ESC, 0x00,
      ...uv("IBMWSCSTNAME", "*NONE")
    ]);
  });

  it("HPT（SBCS）: IBMASCII899=0 が IBMWSCSTNAME の前に入る", () => {
    const r = envReply(37, "*HP4");
    const text = String.fromCharCode(...r);
    expect(text.indexOf("IBMASCII899")).toBeGreaterThan(text.indexOf("IBMENVELOPE"));
    expect(text.indexOf("IBMASCII899")).toBeLessThan(text.indexOf("IBMWSCSTNAME"));
  });

  it("表示セッションは従来どおり IBMSENDCONFREC を送る（sendConfRec の既定は true）", () => {
    const t = new CaptureTransport();
    new TelnetLayer(t, { terminalType: "IBM-3179-2" });
    t.feed([0xff, 0xfa, 0x27, 0x01, 0xff, 0xf0]);
    expect(asciiOf(t.sent.at(-1)!)).toContain("IBMSENDCONFREC");
  });
});
