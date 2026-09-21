import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, type PrinterEntry } from "../src/session-manager.js";
import type { Transport } from "@ts5250/tn5250";

/**
 * **出力に失敗したらホストへの応答を止め、再試行・取消を待つ**（ACS `PSNVT5250P.processPrinterError`。
 * `20260921-printer-hold-response`）。
 *
 * 以前は帳票を受け取った瞬間に応答していたので、PDF の保存先が書けないと SAVE(*NO) のスプールが失われた。
 * 応答を止めている間ホストはスプールを WTR のまま残し、応答すると消す（PUB400 で実測。`scripts/verify-printer-hold.mjs`）。
 */
class FakeTransport implements Transport {
  private dataFn: ((d: Uint8Array) => void) | undefined;
  readonly sent: Uint8Array[] = [];
  constructor(private readonly onStart: (t: FakeTransport) => void) {}
  private closeFn: ((r: string) => void) | undefined;
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
  feed(rec: number[]): void {
    const out: number[] = [];
    for (const b of rec) {
      out.push(b);
      if (b === 0xff) out.push(0xff);
    }
    out.push(0xff, 0xef);
    this.dataFn?.(Uint8Array.from(out));
  }
  /** 送った NO_ERROR の数（`00 0a 12 a0 01 02 04 00 00 01`） */
  noErrors(): number {
    return this.sent.filter((d) => d.length >= 10 && d[1] === 0x0a && d[9] === 0x01 && d[2] === 0x12).length;
  }
}
const I902 = [0xc9, 0xf9, 0xf0, 0xf2];
const startup = (): number[] => {
  const body = [0x12, 0xa0, 0x90, 0x00, 0x04, 0x00, 0x00, 0x00, 0, 0, 0, 0, 0, ...I902];
  return [0x00, body.length + 2, ...body];
};
const data = (scs: number[]): number[] => {
  const body = [0x12, 0xa0, 0x01, 0x01, 0x04, 0x00, 0x00, 0x01, ...scs];
  return [0x00, body.length + 2, ...body];
};
const jobComplete = (): number[] => [0x00, 0x11, 0x12, 0xa0, 0x01, 0x01, 0x0a, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0, 0];

async function openPrinter(autoPdfDir: string): Promise<{ sessions: SessionManager; entry: PrinterEntry; t: FakeTransport }> {
  const sessions = new SessionManager();
  let t!: FakeTransport;
  const entry = await sessions.openPrinter({
    output: { autoPdfDir },
    transport: new FakeTransport((tr) => {
      t = tr;
      tr.feed(startup());
    })
  });
  return { sessions, entry, t };
}
async function waitFor(cond: () => boolean, ms = 4000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return cond();
}
const last = (e: PrinterEntry) => e.outputStatuses[e.outputStatuses.length - 1];

describe("出力に失敗したら応答を止める", () => {
  it("**PDF の保存先が無いとき、ジョブの終わりに応答しない**（データのレコードには応答する）", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "phold-")), "not-yet");
    const { entry, t } = await openPrinter(dir);
    t.feed(data([0xc8, 0xc9]));
    expect(t.noErrors(), "データのレコードには応答する").toBe(1);
    t.feed(jobComplete());
    expect(await waitFor(() => last(entry)?.held === true)).toBe(true);
    expect(t.noErrors(), "失敗したのに印刷完了を返した").toBe(1);
    expect(entry.heldOutput?.config.autoPdfDir).toBe(dir);
  });

  it("**再試行で出力できたら応答する**（保存先を作ってから再試行）", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "phold-")), "not-yet");
    const { sessions, entry, t } = await openPrinter(dir);
    t.feed(data([0xc8, 0xc9]));
    t.feed(jobComplete());
    await waitFor(() => last(entry)?.held === true);
    mkdirSync(dir);
    sessions.retryPrinterOutput(entry.id);
    expect(await waitFor(() => t.noErrors() === 2)).toBe(true);
    expect(last(entry)?.pdf?.ok).toBe(true);
    expect(last(entry)?.held).toBeUndefined();
    expect(readdirSync(dir).some((f) => f.endsWith(".pdf"))).toBe(true);
    expect(entry.heldOutput).toBeUndefined();
  });

  it("再試行でもまた失敗したら止めたまま", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "phold-")), "not-yet");
    const { sessions, entry, t } = await openPrinter(dir);
    t.feed(data([0xc8, 0xc9]));
    t.feed(jobComplete());
    await waitFor(() => last(entry)?.held === true);
    const before = entry.outputStatuses.length;
    sessions.retryPrinterOutput(entry.id);
    expect(await waitFor(() => entry.outputStatuses.length > before && last(entry)?.held === true)).toBe(true);
    expect(t.noErrors()).toBe(1);
  });

  it("**取消は応答する**（ホストは印刷済みとみなす）。状態は取消", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "phold-")), "not-yet");
    const { sessions, entry, t } = await openPrinter(dir);
    t.feed(data([0xc8, 0xc9]));
    t.feed(jobComplete());
    await waitFor(() => last(entry)?.held === true);
    sessions.cancelPrinterOutput(entry.id);
    expect(await waitFor(() => t.noErrors() === 2)).toBe(true);
    expect(last(entry)?.canceled).toBe(true);
    expect(entry.reports.length, "帳票はサーバーの一覧に残る").toBe(1);
  });

  it("止めている間に届いたレコードは、応答のあとに処理する（順は変えない）", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "phold-")), "not-yet");
    const { sessions, entry, t } = await openPrinter(dir);
    t.feed(data([0xc8, 0xc9]));
    t.feed(jobComplete());
    await waitFor(() => last(entry)?.held === true);
    t.feed(data([0xc1])); // 次のジョブのデータ（本来ホストは応答を待つが、届いても溜める）
    expect(t.noErrors(), "止めている間に応答した").toBe(1);
    sessions.cancelPrinterOutput(entry.id);
    expect(await waitFor(() => t.noErrors() === 3)).toBe(true);
  });

  it("自動出力を切ってあれば待たずに応答する", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "phold-")), "not-yet");
    const { sessions, entry, t } = await openPrinter(dir);
    sessions.setPrinterOutputEnabled(entry.id, false);
    t.feed(data([0xc8, 0xc9]));
    t.feed(jobComplete());
    expect(t.noErrors()).toBe(2);
    expect(last(entry)?.skipped).toBe(true);
  });

  it("止めている帳票が無いのに再試行・取消を呼ぶと NOT_FOUND", async () => {
    const dir = mkdtempSync(join(tmpdir(), "phold-"));
    const { sessions, entry } = await openPrinter(dir);
    expect(() => sessions.retryPrinterOutput(entry.id)).toThrow(/no held/);
    expect(() => sessions.cancelPrinterOutput(entry.id)).toThrow(/no held/);
  });
});

describe("再試行は失敗した出力だけ・切断後は再試行できない", () => {
  it("**成功した PDF は再試行で書き直さない**（失敗した印刷だけやり直す）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "phold-"));
    const sessions = new SessionManager();
    let t!: FakeTransport;
    const entry = await sessions.openPrinter({
      // 印刷先は存在しない名前（`lp` が無い環境でも、ある環境でも失敗する）
      output: { autoPdfDir: dir, autoPrint: "ts5250-no-such-printer" },
      transport: new FakeTransport((tr) => {
        t = tr;
        tr.feed(startup());
      })
    });
    t.feed(data([0xc8, 0xc9]));
    t.feed(jobComplete());
    expect(await waitFor(() => last(entry)?.held === true)).toBe(true);
    expect(last(entry)?.pdf?.ok, "前提: PDF は書けた").toBe(true);
    expect(entry.heldOutput?.config.autoPdfDir, "再試行に PDF が入っている").toBeUndefined();
    const before = entry.outputStatuses.length;
    sessions.retryPrinterOutput(entry.id);
    expect(await waitFor(() => entry.outputStatuses.length > before)).toBe(true);
    expect(readdirSync(dir).filter((f) => f.endsWith(".pdf")), "PDF を書き直した").toHaveLength(1);
  });

  it("**接続が切れたら止めていた帳票は手放す**（ホストは繋ぎ直しで送り直す。再試行は NOT_FOUND）", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "phold-")), "not-yet");
    const { sessions, entry, t } = await openPrinter(dir);
    t.feed(data([0xc8, 0xc9]));
    t.feed(jobComplete());
    await waitFor(() => last(entry)?.held === true);
    entry.session!.disconnect();
    expect(entry.heldOutput).toBeUndefined();
    expect(() => sessions.retryPrinterOutput(entry.id)).toThrow(/no held/);
  });
});

describe("ws: printer-output-retry / printer-output-cancel", () => {
  it("開いているプリンターセッションの止めている帳票を再試行・取消する", async () => {
    const { WsConnection } = await import("../src/ws-handler.js");
    const calls: string[] = [];
    const sessions = {
      retryPrinterOutput: (id: string) => void calls.push(`retry:${id}`),
      cancelPrinterOutput: (id: string) => void calls.push(`cancel:${id}`)
    } as unknown as SessionManager;
    const ws = new WsConnection({ sessions, resolver: {} as never }, { send: () => {} });
    // 開いているセッションは `link` の id（`sessionId` はその getter）
    (ws as unknown as { link: { id: string } }).link = { id: "p1" };
    await ws.handle(JSON.stringify({ type: "printer-output-retry" }));
    await ws.handle(JSON.stringify({ type: "printer-output-cancel" }));
    expect(calls).toEqual(["retry:p1", "cancel:p1"]);
  });
});
