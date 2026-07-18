import { describe, it, expect } from "vitest";
import { mkdtempSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, type PrinterEntry } from "../src/session-manager.js";
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
  return [0x00, body.length + 2, ...body];
};
const data = (scs: number[]): number[] => {
  const body = [0x12, 0xa0, 0x01, 0x01, 0x04, 0x00, 0x00, 0x01, ...scs];
  return [0x00, body.length + 2, ...body];
};
const jobComplete = (): number[] => [0x00, 0x11, 0x12, 0xa0, 0x01, 0x01, 0x04, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0, 0];

/** 出力設定付きでプリンターセッションを開く */
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
/** 1 スプールを流し込む（データ＋ジョブ完了） */
function feedSpool(t: FakeTransport): void {
  t.feed(data([0xc8, 0xc9])); // EBCDIC "HI"
  t.feed(jobComplete());
}
/** 条件が満たされるまで待つ（自動出力は非同期） */
async function waitFor(cond: () => boolean, ms = 4000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return cond();
}

describe("プリンター自動出力: 実行時 ON/OFF と警告", () => {
  it("既定は有効で、受信すると PDF が書かれる", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pout-"));
    const { entry, t } = await openPrinter(dir);
    expect(entry.output).toBeDefined();
    expect(entry.outputEnabled).toBe(true);
    feedSpool(t);
    expect(await waitFor(() => readdirSync(dir).some((f) => f.endsWith(".pdf")))).toBe(true);
  });

  it("無効化すると自動出力されず、再度有効化すると再開する", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pout-"));
    const { sessions, entry, t } = await openPrinter(dir);
    // 無効化 → 受信しても PDF は書かれない
    sessions.setPrinterOutputEnabled(entry.id, false);
    expect(entry.outputEnabled).toBe(false);
    feedSpool(t);
    await new Promise((r) => setTimeout(r, 300));
    expect(readdirSync(dir).filter((f) => f.endsWith(".pdf"))).toHaveLength(0);
    // スプール自体は受信できている（自動出力だけ止まる）
    expect(entry.reports.length).toBe(1);

    // 再度有効化 → 次の受信で書かれる
    sessions.setPrinterOutputEnabled(entry.id, true);
    feedSpool(t);
    expect(await waitFor(() => readdirSync(dir).some((f) => f.endsWith(".pdf")))).toBe(true);
  });

  it("出力先が無いと警告が履歴に積まれ push される（受信は妨げない）", async () => {
    const missing = join(mkdtempSync(join(tmpdir(), "pout-")), "does-not-exist");
    expect(existsSync(missing)).toBe(false);
    const { entry, t } = await openPrinter(missing);
    const pushed: string[] = [];
    entry.onOutputWarn = (w) => pushed.push(w.message);
    feedSpool(t);
    expect(await waitFor(() => entry.outputWarnings.length > 0)).toBe(true);
    expect(entry.outputWarnings[0]!.message).toMatch(/PDF 保存に失敗|ENOENT/);
    expect(pushed.length).toBeGreaterThan(0);
    // 受信自体は成功している
    expect(entry.reports.length).toBe(1);
  });

  it("成功すると PDF の保存先が結果ステータスに載る", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pout-"));
    const { entry, t } = await openPrinter(dir);
    const pushed: unknown[] = [];
    entry.onOutputStatus = (s) => pushed.push(s);
    feedSpool(t);
    expect(await waitFor(() => entry.outputStatuses.length > 0)).toBe(true);
    const s = entry.outputStatuses[0]!;
    expect(s.spoolId).toBeTruthy();
    expect(s.pdf?.ok).toBe(true);
    expect(s.pdf?.path).toMatch(/\.pdf$/);
    expect(s.print).toBeUndefined(); // autoPrint 未設定なのでキーごと省略
    expect(pushed.length).toBe(1);
  });

  it("失敗すると結果ステータスに理由が載る", async () => {
    const missing = join(mkdtempSync(join(tmpdir(), "pout-")), "nope");
    const { entry, t } = await openPrinter(missing);
    feedSpool(t);
    expect(await waitFor(() => entry.outputStatuses.length > 0)).toBe(true);
    const s = entry.outputStatuses[0]!;
    expect(s.pdf?.ok).toBe(false);
    expect(s.pdf?.error).toMatch(/PDF 保存に失敗|ENOENT/);
  });

  it("自動出力オフ中の受信は skipped として記録される", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pout-"));
    const { sessions, entry, t } = await openPrinter(dir);
    sessions.setPrinterOutputEnabled(entry.id, false);
    feedSpool(t);
    expect(await waitFor(() => entry.outputStatuses.length > 0)).toBe(true);
    expect(entry.outputStatuses[0]!.skipped).toBe(true);
    expect(entry.outputStatuses[0]!.pdf).toBeUndefined();
  });

  it("出力設定が無ければステータスを作らない", async () => {
    const sessions = new SessionManager();
    let t!: FakeTransport;
    const entry = await sessions.openPrinter({
      transport: new FakeTransport((tr) => {
        t = tr;
        tr.feed(startup());
      })
    });
    feedSpool(t);
    await new Promise((r) => setTimeout(r, 200));
    expect(entry.outputStatuses).toHaveLength(0);
    expect(entry.reports.length).toBe(1);
  });

  it("他ユーザーは切り替えできない（FORBIDDEN）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pout-"));
    const sessions = new SessionManager();
    let t!: FakeTransport;
    const entry = await sessions.openPrinter({
      owner: "alice",
      output: { autoPdfDir: dir },
      transport: new FakeTransport((tr) => {
        t = tr;
        tr.feed(startup());
      })
    });
    void t;
    expect(() =>
      sessions.setPrinterOutputEnabled(entry.id, false, { username: "bob", role: "user" })
    ).toThrow(/forbidden/i);
  });
});
