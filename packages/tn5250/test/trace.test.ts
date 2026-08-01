import { describe, it, expect } from "vitest";
import { TraceRecorder, parseTraceJsonl, bytesToHex, hexToBytes } from "../src/trace/trace.js";
import { ReplayTransport } from "../src/trace/replay.js";
import { TelnetLayer } from "../src/telnet/telnet.js";
import { IAC, CMD, OPT } from "../src/telnet/constants.js";

describe("TraceRecorder", () => {
  it("rx は hex、tx は既定で伏字化して記録する", () => {
    const lines: string[] = [];
    const rec = new TraceRecorder((l) => lines.push(l), { now: () => "2026-07-15T00:00:00Z" });
    rec.rx(Uint8Array.from([0x01, 0xff]));
    rec.tx(Uint8Array.from([0xc1, 0xc2, 0xc3]));
    const entries = parseTraceJsonl(lines.join("\n"));
    expect(entries[0]).toEqual({ ts: "2026-07-15T00:00:00Z", dir: "rx", hex: "01ff" });
    expect(entries[1]).toEqual({ ts: "2026-07-15T00:00:00Z", dir: "tx", len: 3, masked: true });
  });

  it("maskTx: false なら tx も hex で残す", () => {
    const lines: string[] = [];
    const rec = new TraceRecorder((l) => lines.push(l), { maskTx: false, now: () => "t" });
    rec.tx(Uint8Array.from([0xaa]));
    expect(parseTraceJsonl(lines[0] ?? "")[0]).toEqual({ ts: "t", dir: "tx", hex: "aa" });
  });

  it("hex ヘルパがラウンドトリップする", () => {
    const bytes = Uint8Array.from([0, 1, 0x7f, 0x80, 0xff]);
    expect(hexToBytes(bytesToHex(bytes))).toEqual(bytes);
  });
});

describe("ReplayTransport", () => {
  it("rx を流し、tx エントリで send を待って進む", () => {
    const t = new ReplayTransport([
      { ts: "t", dir: "rx", hex: "0102" },
      { ts: "t", dir: "tx", len: 1, masked: true },
      { ts: "t", dir: "rx", hex: "03" }
    ]);
    const received: number[] = [];
    t.onData((d) => received.push(...d));
    t.start();
    expect(received).toEqual([1, 2]); // tx 手前で停止
    expect(t.finished).toBe(false);
    t.send(Uint8Array.from([9]));
    expect(received).toEqual([1, 2, 3]);
    expect(t.finished).toBe(true);
    expect(t.sentChunks.map((c) => [...c])).toEqual([[9]]);
  });

  it("TelnetLayer と組み合わせてネゴ＋レコードを再生できる", () => {
    // 記録: サーバー DO TERMINAL_TYPE → (クライアント WILL) → レコード 0x11 0x22
    const t = new ReplayTransport([
      { ts: "t", dir: "rx", hex: bytesToHex(Uint8Array.from([IAC, CMD.DO, OPT.TERMINAL_TYPE])) },
      { ts: "t", dir: "tx", len: 3, masked: true },
      { ts: "t", dir: "rx", hex: bytesToHex(Uint8Array.from([0x11, 0x22, IAC, CMD.EOR])) }
    ]);
    const telnet = new TelnetLayer(t, { terminalType: "IBM-3179-2" });
    const records: number[][] = [];
    telnet.onRecord((r) => records.push([...r]));
    t.start();
    expect(records).toEqual([[0x11, 0x22]]);
    expect(t.finished).toBe(true);
    // クライアントの WILL 応答が送信として捕捉されている
    expect(t.sentChunks[0] && [...t.sentChunks[0]]).toEqual([IAC, CMD.WILL, OPT.TERMINAL_TYPE]);
  });

  it("closeAtEnd で終端時に onClose を発火する", () => {
    const t = new ReplayTransport([{ ts: "t", dir: "rx", hex: "01" }], { closeAtEnd: true });
    let closed = "";
    t.onClose((r) => (closed = r));
    t.onData(() => {});
    t.start();
    expect(closed).toBe("replay finished");
  });
});
