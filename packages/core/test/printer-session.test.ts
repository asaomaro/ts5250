import { describe, it, expect } from "vitest";
import { PrinterSession, type SpoolReport } from "../src/session/printer-session.js";
import type { Transport } from "../src/transport/types.js";

/** IAC EOR 付きで records をまとめて供給できる最小 Transport（telnet 交渉なしで直接レコードを流す） */
class FakeTransport implements Transport {
  sent: Uint8Array[] = [];
  private dataFn: ((d: Uint8Array) => void) | undefined;
  private closeFn: ((r: string) => void) | undefined;
  constructor(private readonly onStart: (t: FakeTransport) => void) {}
  send(d: Uint8Array): void {
    this.sent.push(d);
  }
  close(): void {
    this.closeFn?.("closed by client");
  }
  onData(fn: (d: Uint8Array) => void): void {
    this.dataFn = fn;
  }
  onClose(fn: (r: string) => void): void {
    this.closeFn = fn;
  }
  onError(): void {}
  start(): void {
    this.onStart(this);
  }
  /** レコードを IAC EOR 付き（IAC は二重化）で供給する */
  feed(rec: number[]): void {
    const out: number[] = [];
    for (const b of rec) {
      out.push(b);
      if (b === 0xff) out.push(0xff);
    }
    out.push(0xff, 0xef); // IAC EOR
    this.dataFn?.(Uint8Array.from(out));
  }
}

// 起動応答レコード: (6+rec[6])+5 の 4 バイト EBCDIC に code。rec[6]=0x04 → o=10, code at 15
function startupRecord(codeEbcdic: number[]): number[] {
  const header = [0x12, 0xa0, 0x90, 0x00, 0x04, 0x00, 0x00, 0x00]; // [2..9]
  const pad = [0x00, 0x00, 0x00, 0x00, 0x00]; // [10..14]
  const body = [...header, ...pad, ...codeEbcdic]; // 開始は [2]
  const ll = body.length + 2;
  return [(ll >> 8) & 0xff, ll & 0xff, ...body];
}
// 印刷データレコード（opcode=1）。payload は SCS。rec[6]=0x04 → payload は offset 10 から
function dataRecord(scs: number[]): number[] {
  const body = [0x12, 0xa0, 0x01, 0x01, 0x04, 0x00, 0x00, 0x01, ...scs];
  const ll = body.length + 2;
  return [(ll >> 8) & 0xff, ll & 0xff, ...body];
}
// ジョブ完了レコード（長さ 0x11=17）
function jobCompleteRecord(): number[] {
  const rec = [0x00, 0x11, 0x12, 0xa0, 0x01, 0x01, 0x04, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0, 0];
  return rec; // 17 バイト
}

const I902 = [0xc9, 0xf9, 0xf0, 0xf2]; // EBCDIC "I902"
const E8925 = [0xf8, 0xf9, 0xf2, 0xf5]; // EBCDIC "8925"

describe("PrinterSession", () => {
  it("起動応答 I902 で接続し、ジョブ完了で report を1件発火する", async () => {
    const reports: SpoolReport[] = [];
    let transport!: FakeTransport;
    const session = await PrinterSession.connect({
      transport: new FakeTransport((t) => {
        transport = t;
        t.feed(startupRecord(I902)); // 起動応答 → connect 解決
      })
    });
    session.on("report", (r) => reports.push(r));
    expect(session.startupCode).toBe("I902");

    // 印刷データ（EBCDIC "AB"）→ ジョブ完了
    transport.feed(dataRecord([0xc1, 0xc2]));
    transport.feed(jobCompleteRecord());

    expect(reports).toHaveLength(1);
    expect(reports[0]!.pages).toHaveLength(1);
    expect(reports[0]!.pages[0]!.lines[0]).toBe("AB");
    // 各印刷データレコード後に print-complete を返す（データ＋ジョブ完了の 2 回）
    expect(transport.sent.length).toBe(2);
    // print-complete の本体（IAC EOR 前）は 00 0a 12 a0 00 12 04 00 00 01
    expect([...transport.sent[0]!.subarray(0, 10)]).toEqual([0x00, 0x0a, 0x12, 0xa0, 0x00, 0x12, 0x04, 0x00, 0x00, 0x01]);
  });

  it("起動応答が失敗コード（8925）なら SESSION_REJECTED で接続を拒否する", async () => {
    await expect(
      PrinterSession.connect({
        transport: new FakeTransport((t) => t.feed(startupRecord(E8925)))
      })
    ).rejects.toMatchObject({ code: "SESSION_REJECTED" });
  });
});
