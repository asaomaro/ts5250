import { describe, it, expect } from "vitest";
import { SessionManager } from "../src/session-manager.js";
import type { StoredReport } from "../src/session-manager.js";
import type { Transport } from "@as400web/tn5250";

/**
 * **帳票の受信時刻はサーバーが刻む**（`20260802-printer-report-history`）。
 *
 * これが無いと、常駐中に溜まった帳票を後から開いたときに受信時刻を**クライアントが
 * 現在時刻で押す**ことになり、夜中に出た帳票が全部「いま届いた」になる。
 * `SpoolReport`（`@as400web/tn5250`）はプロトコル層の型で時計を持たないので、
 * サーバー側の派生型 `StoredReport` に足してある。
 *
 * 刻む場所は `deliverReport` 1 か所——push でも救出でも同じ道を通る funnel。
 */
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
const transport = (): Transport => new FakeTransport((tr) => tr.feed(startup()));

/** 注入クロック。**時計を固定できないと「刻んだ」ことを実際の値で確かめられない** */
const CLOCK = 1_700_000_000_000;

async function open(now: () => number) {
  const sessions = new SessionManager({ now });
  const entry = await sessions.openPrinter({ transport: transport() });
  return { sessions, entry };
}

/** `deliverReport` は private。配る道はここ 1 本なので直接叩いて確かめる */
function deliver(sessions: SessionManager, id: string, reportId: string): void {
  const m = sessions as unknown as { deliverReport: (e: unknown, r: unknown) => void };
  const e = sessions.listPrinters().find((x) => x.id === id)!;
  m.deliverReport(e, { id: reportId, pages: [] });
}

describe("帳票の受信時刻", () => {
  it("`deliverReport` が受信時刻を刻む", async () => {
    const { sessions, entry } = await open(() => CLOCK);
    deliver(sessions, entry.id, "s1");
    expect(entry.reports[0]?.receivedAt).toBe(CLOCK);
  });

  it("**帳票ごとに刻む**（溜まった分が同じ時刻で並ばない）", async () => {
    let t = CLOCK;
    const { sessions, entry } = await open(() => t);
    deliver(sessions, entry.id, "s1");
    t += 60_000;
    deliver(sessions, entry.id, "s2");
    expect(entry.reports.map((r) => r.receivedAt)).toEqual([CLOCK, CLOCK + 60_000]);
  });

  it("**live の push にも同じ 1 個が渡る**（開き直しだけ直して live を忘れない）", async () => {
    const { sessions, entry } = await open(() => CLOCK);
    const pushed: StoredReport[] = [];
    entry.onReport = (r) => pushed.push(r);
    deliver(sessions, entry.id, "s1");
    expect(pushed[0]?.receivedAt).toBe(CLOCK);
    // バッファに入ったものと**同一のオブジェクト**——作り直すと片方だけ直る形になる
    expect(pushed[0]).toBe(entry.reports[0]);
  });

  it("`waitSpool`（MCP）が返す帳票にも載る", async () => {
    const { sessions, entry } = await open(() => CLOCK);
    deliver(sessions, entry.id, "s1");
    const got = await sessions.waitSpool(entry.id, 10);
    expect((got as StoredReport | undefined)?.receivedAt).toBe(CLOCK);
  });
});
