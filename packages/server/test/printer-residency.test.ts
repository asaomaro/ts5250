import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, DEFAULT_MAX_RESIDENT_PRINTERS } from "../src/session-manager.js";
import type { Transport } from "@as400web/tn5250";

/**
 * **プリンターの常駐**（`20260801-printer-session-residency`）。
 *
 * 「設定が仕事をする」サービス型なので、ブラウザを閉じても帳票を受け取り続ける。
 * 常駐の条件は**出力設定（`output`）の有無**——それは
 * `config-resolver.ts` がサーバー設定由来のときにしか供給しないので、
 * **常駐の条件と信頼境界がちょうど重なる**（design D1）。
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

/** 出力設定の有無だけを変えてプリンターを開く */
async function open(sessions: SessionManager, withOutput: boolean) {
  const dir = join(mkdtempSync(join(tmpdir(), "prt-")), "out");
  return sessions.openPrinter({
    ...(withOutput ? { output: { autoPdfDir: dir } } : {}),
    transport: transport()
  });
}

describe("常駐の条件", () => {
  it("出力設定があれば常駐（サーバー設定由来だけが持つ）", async () => {
    const sessions = new SessionManager();
    const entry = await open(sessions, true);
    expect(entry.resident).toBe(true);
    expect(sessions.isResident(entry.id)).toBe(true);
  });

  it("出力設定が無ければ常駐しない（直接接続は出力設定を受け取れない）", async () => {
    const sessions = new SessionManager();
    const entry = await open(sessions, false);
    expect(entry.resident).toBe(false);
    expect(sessions.isResident(entry.id)).toBe(false);
  });

  it("知らない id は常駐扱いしない（切り忘れより切りすぎを選ぶ）", () => {
    const sessions = new SessionManager();
    expect(sessions.isResident("no-such-id")).toBe(false);
  });
});

describe("アイドル掃除", () => {
  /** 掃除は `lastActivity` と現在時刻の差で決まるので、時計を進めて見る */
  function managerWithClock(now: () => number, idleTimeoutMs: number): SessionManager {
    return new SessionManager({ now, idleTimeoutMs });
  }
  /** `sweepIdle` は private。既存テスト（session-manager.test.ts）と同じ流儀で直接叩く */
  const sweep = (m: SessionManager): void =>
    (m as unknown as { sweepIdle: () => void }).sweepIdle();

  it("常駐は掃除で消えない（何も届かない状態が正常なので、アイドルを合図にできない）", async () => {
    let clock = 1_000;
    const sessions = managerWithClock(() => clock, 60_000);
    const entry = await open(sessions, true);
    clock += 10 * 60_000;
    sweep(sessions);
    expect(sessions.listPrinters().some((e) => e.id === entry.id)).toBe(true);
  });

  it("常駐でないプリンターは従来どおり掃除される", async () => {
    let clock = 1_000;
    const sessions = managerWithClock(() => clock, 60_000);
    const entry = await open(sessions, false);
    clock += 10 * 60_000;
    sweep(sessions);
    expect(sessions.listPrinters().some((e) => e.id === entry.id)).toBe(false);
  });
});

describe("上限", () => {
  it("常駐は表示セッションの枠を食わない（帳票を待たせて画面が開けなくならない）", async () => {
    // 表示の上限を 1 にしても、常駐プリンターがあるだけでは埋まらない
    const sessions = new SessionManager({ maxSessions: 1 });
    await open(sessions, true);
    expect(sessions.size).toBe(0);
  });

  it("常駐でないプリンターは表示の枠を食う（従来どおり）", async () => {
    const sessions = new SessionManager({ maxSessions: 1 });
    await open(sessions, false);
    expect(sessions.size).toBe(1);
    await expect(open(sessions, false)).rejects.toMatchObject({ code: "SESSION_LIMIT" });
  });

  it("常駐にも上限がある（無制限に張らせない）", async () => {
    const sessions = new SessionManager({ maxResidentPrinters: 2 });
    await open(sessions, true);
    await open(sessions, true);
    await expect(open(sessions, true)).rejects.toMatchObject({ code: "SESSION_LIMIT" });
  });

  it("常駐の上限に既定がある", () => {
    expect(DEFAULT_MAX_RESIDENT_PRINTERS).toBe(4);
  });
});
