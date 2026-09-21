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
  /** 送った CLEAR_PROCESSED の数（`00 0a 12 a0 01 02 04 00 00 02`） */
  clearProcessed(): number {
    return this.sent.filter((d) => d.length >= 10 && d[1] === 0x0a && d[9] === 0x02 && d[2] === 0x12).length;
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
/** CLEAR（opcode 2） */
const clear = (): number[] => [0x00, 0x10, 0x12, 0xa0, 0x01, 0x01, 0x0a, 0x18, 0x00, 0x02, 0, 0, 0, 0, 0, 0];

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
    expect(entry.heldOutput?.failed).toEqual({ pdf: true, print: false });
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
    expect(entry.heldOutput?.failed, "再試行に PDF が入っている").toEqual({ pdf: false, print: true });
    const before = entry.outputStatuses.length;
    sessions.retryPrinterOutput(entry.id);
    expect(await waitFor(() => entry.outputStatuses.length > before)).toBe(true);
    expect(readdirSync(dir).filter((f) => f.endsWith(".pdf")), "PDF を書き直した").toHaveLength(1);
    // やり直さなかった PDF の結果（✓ と保存先）は引き継ぐ（独立点検の指摘: 置き換えて消えていた）
    expect(last(entry)?.pdf?.ok).toBe(true);
    expect(last(entry)?.pdf?.path).toBeDefined();
    expect(last(entry)?.print?.ok).toBe(false);
  });

  it("取消でも成功していた PDF の結果は残る", async () => {
    const dir = mkdtempSync(join(tmpdir(), "phold-"));
    const sessions = new SessionManager();
    let t!: FakeTransport;
    const entry = await sessions.openPrinter({
      output: { autoPdfDir: dir, autoPrint: "ts5250-no-such-printer" },
      transport: new FakeTransport((tr) => {
        t = tr;
        tr.feed(startup());
      })
    });
    t.feed(data([0xc8, 0xc9]));
    t.feed(jobComplete());
    await waitFor(() => last(entry)?.held === true);
    sessions.cancelPrinterOutput(entry.id);
    expect(last(entry)).toMatchObject({ canceled: true, pdf: { ok: true } });
    expect(last(entry)?.held).toBeUndefined();
  });

  // ホストは切れたジョブを印刷済みにしない（RDY に戻る）。繋ぎ直すと書き出しプログラムが送り直す（PUB400 で 2 回実測。
  // `scripts/verify-printer-hold-drop.mjs`——用紙の問い合わせに答えた後で届いた。答えなかった回は 60 秒届かず MSGW のまま）
  it("**接続が切れたら止めていた帳票は手放し、画面へ `dropped` を出す**（再試行は NOT_FOUND）", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "phold-")), "not-yet");
    const { sessions, entry, t } = await openPrinter(dir);
    const pushed: unknown[] = [];
    entry.listeners.add({ onOutputStatus: (st) => pushed.push(st) });
    t.feed(data([0xc8, 0xc9]));
    t.feed(jobComplete());
    await waitFor(() => last(entry)?.held === true);
    entry.session!.disconnect();
    expect(entry.heldOutput).toBeUndefined();
    expect(last(entry)).toMatchObject({ dropped: true });
    expect(last(entry)?.held, "再試行バーが下りない").toBeUndefined();
    expect(pushed[pushed.length - 1], "画面へ知らせていない").toMatchObject({ dropped: true });
    expect(() => sessions.retryPrinterOutput(entry.id)).toThrow(/no held/);
  });

  it("**出力が終わる前に切れたら、失敗しても止めない**（閉じた接続の応答を持つ帳票を残さない）", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "phold-")), "not-yet");
    const { entry, t } = await openPrinter(dir);
    t.feed(data([0xc8, 0xc9]));
    t.feed(jobComplete()); // 出力は非同期に走り出す
    entry.session!.disconnect(); // 終わる前に切れる（停止・切断・張り直し）
    expect(await waitFor(() => last(entry)?.dropped === true)).toBe(true);
    expect(entry.heldOutput, "閉じた接続の帳票を止めた").toBeUndefined();
  });
});

describe("ws: printer-output-retry / printer-output-cancel", () => {
  it("開いているプリンターセッションの止めている帳票を再試行・取消する", async () => {
    const { WsConnection } = await import("../src/ws-handler.js");
    const calls: string[] = [];
    // **利用者も渡すこと**（認可は `getPrinter` の所有者/admin。落とすと素通りする。独立点検の指摘）
    const sessions = {
      retryPrinterOutput: (id: string, user?: { username: string }) => void calls.push(`retry:${id}:${user?.username}`),
      cancelPrinterOutput: (id: string, user?: { username: string }) => void calls.push(`cancel:${id}:${user?.username}`)
    } as unknown as SessionManager;
    const ws = new WsConnection({ sessions, resolver: {} as never }, { send: () => {} }, {
      username: "alice",
      role: "user"
    } as never);
    // 開いているセッションは `link` の id（`sessionId` はその getter）
    (ws as unknown as { link: { id: string } }).link = { id: "p1" };
    await ws.handle(JSON.stringify({ type: "printer-output-retry" }));
    await ws.handle(JSON.stringify({ type: "printer-output-cancel" }));
    expect(calls).toEqual(["retry:p1:alice", "cancel:p1:alice"]);
  });
});

describe("独立点検の指摘（`20260921-printer-hold-response`）", () => {
  it("**ホスト変換で PDF を作れないのは失敗ではない**——止めずに応答する（`pdf.skipped`）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "phold-"));
    const sessions = new SessionManager();
    let t!: FakeTransport;
    const entry = await sessions.openPrinter({
      transformTo: "*HP4",
      output: { autoPdfDir: dir },
      transport: new FakeTransport((tr) => {
        t = tr;
        tr.feed(startup());
      })
    });
    t.feed(data([0xc8, 0xc9]));
    t.feed(jobComplete());
    expect(await waitFor(() => t.noErrors() === 2), "帳票ごとに応答が止まった").toBe(true);
    expect(last(entry)).toMatchObject({ pdf: { ok: false, skipped: true } });
    expect(last(entry)?.held).toBeUndefined();
  });

  it("**自動出力を切ったら止めている帳票も応答する**（切っている間は止めない）", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "phold-")), "not-yet");
    const { sessions, entry, t } = await openPrinter(dir);
    t.feed(data([0xc8, 0xc9]));
    t.feed(jobComplete());
    await waitFor(() => last(entry)?.held === true);
    sessions.setPrinterOutputEnabled(entry.id, false);
    expect(await waitFor(() => t.noErrors() === 2)).toBe(true);
    expect(entry.heldOutput).toBeUndefined();
    expect(last(entry)).toMatchObject({ skipped: true });
    expect(() => sessions.retryPrinterOutput(entry.id)).toThrow(/no held/);
  });

  it("**再試行はいまの設定で出力する**（止めている間に保存先を直せば、直した先へ書く）", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "phold-")), "not-yet");
    const fixed = mkdtempSync(join(tmpdir(), "phold-fixed-"));
    const { sessions, entry, t } = await openPrinter(dir);
    t.feed(data([0xc8, 0xc9]));
    t.feed(jobComplete());
    await waitFor(() => last(entry)?.held === true);
    entry.output = { autoPdfDir: fixed }; // 定義の保存先を直した（`updatePrinterOptions` と同じく entry.output が変わる）
    sessions.retryPrinterOutput(entry.id);
    expect(await waitFor(() => t.noErrors() === 2)).toBe(true);
    expect(readdirSync(fixed).some((f) => f.endsWith(".pdf"))).toBe(true);
  });

  it("止めている間に設定からその出力が外されたら、再試行は応答する（やり直すものが無い）", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "phold-")), "not-yet");
    const { sessions, entry, t } = await openPrinter(dir);
    t.feed(data([0xc8, 0xc9]));
    t.feed(jobComplete());
    await waitFor(() => last(entry)?.held === true);
    delete entry.output;
    sessions.retryPrinterOutput(entry.id);
    expect(await waitFor(() => t.noErrors() === 2)).toBe(true);
    expect(last(entry)?.held).toBeUndefined();
    expect(last(entry)?.pdf, "外した出力の失敗を引き継いだ").toBeUndefined();
  });

  it("**CLEAR で閉じた帳票は止めない**（出力は失敗として記録し、すぐ CLEAR_PROCESSED を返す）", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "phold-")), "not-yet");
    const { entry, t } = await openPrinter(dir);
    t.feed(data([0xc8, 0xc9]));
    t.feed(clear());
    expect(t.clearProcessed(), "CLEAR に応答していない").toBe(1);
    expect(await waitFor(() => last(entry) !== undefined)).toBe(true);
    expect(last(entry)).toMatchObject({ pdf: { ok: false } });
    expect(last(entry)?.held).toBeUndefined();
    expect(entry.heldOutput).toBeUndefined();
  });

  it("帳票の id は接続をまたいで数える（`spoolSeq`）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "phold-"));
    const { entry, t } = await openPrinter(dir);
    t.feed(data([0xc8]));
    t.feed(jobComplete());
    expect(entry.reports.map((r) => r.id)).toEqual(["spool-1"]);
    expect(entry.spoolSeq).toBe(1);
  });

  it("**画面が 2 つ開いていれば両方へ配る**。片方を外してももう片方には届く", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "phold-")), "not-yet");
    const { entry, t } = await openPrinter(dir);
    const a: unknown[] = [];
    const b: unknown[] = [];
    const la = { onOutputStatus: (st: unknown) => void a.push(st) };
    const lb = { onOutputStatus: (st: unknown) => void b.push(st) };
    entry.listeners.add(la);
    entry.listeners.add(lb);
    entry.listeners.delete(lb); // 後から開いたタブを閉じた
    t.feed(data([0xc8, 0xc9]));
    t.feed(jobComplete());
    expect(await waitFor(() => a.length === 1)).toBe(true);
    expect(b).toHaveLength(0);
  });
});
