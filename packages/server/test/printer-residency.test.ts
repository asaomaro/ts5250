import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, DEFAULT_MAX_RESIDENT_PRINTERS } from "../src/session-manager.js";
import type { Transport } from "@as400web/tn5250";

/**
 * **プリンターの常駐**（`20260801-printer-session-residency` →
 * `20260801-service-lifecycle-model` で作り直し）。
 *
 * 「設定が仕事をする」サービス型なので、ブラウザを閉じても帳票を受け取り続ける。
 *
 * **常駐の条件は「サービスとして利用する ✅」**（`opts.service`）。
 * 以前は出力設定（`output`）の有無から**導出**していたが、それだと
 * 「開いている間だけ PDF に落とす」も「常駐して溜めるだけ」も表現できなかった。
 * **意図（サービス）と能力（出力設定）は別の軸**（`service-lifecycle-model` design D3）。
 *
 * `service` を受理するのはサーバー設定由来のときだけ（`config-resolver.ts` の 5 層目）
 * なので、**常駐の条件と信頼境界は重なったまま**。
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

/** サービス ✅ と出力設定を**別々に**指定して開く（軸が分かれていることを試すため） */
async function open(
  sessions: SessionManager,
  opts: { service?: boolean; output?: boolean } = {}
) {
  const dir = join(mkdtempSync(join(tmpdir(), "prt-")), "out");
  return sessions.openPrinter({
    ...(opts.service ? { service: true } : {}),
    ...(opts.output ? { output: { autoPdfDir: dir } } : {}),
    transport: transport()
  });
}

describe("常駐の条件", () => {
  it("サービス ✅ なら常駐（サーバー設定由来だけが持てる）", async () => {
    const sessions = new SessionManager();
    const entry = await open(sessions, { service: true });
    expect(entry.resident).toBe(true);
    expect(sessions.isResident(entry.id)).toBe(true);
  });

  it("サービス ✅ が無ければ常駐しない（直接接続は受け取れない）", async () => {
    const sessions = new SessionManager();
    const entry = await open(sessions, {});
    expect(entry.resident).toBe(false);
    expect(sessions.isResident(entry.id)).toBe(false);
  });

  it("**出力設定があっても、サービス ✅ が無ければ常駐しない**", async () => {
    // 「開いている間だけ PDF に落としたい」——導出していた頃は表現できなかった
    const sessions = new SessionManager();
    const entry = await open(sessions, { output: true });
    expect(entry.resident).toBe(false);
  });

  it("**サービス ✅ だけでも常駐する（出力設定なし＝溜めるだけ）**", async () => {
    // 受け取って溜めておき、後で画面で見る使い方。これも導出では表現できなかった
    const sessions = new SessionManager();
    const entry = await open(sessions, { service: true });
    expect(entry.resident).toBe(true);
    expect(entry.output).toBeUndefined();
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
    const entry = await open(sessions, { service: true });
    clock += 10 * 60_000;
    sweep(sessions);
    expect(sessions.listPrinters().some((e) => e.id === entry.id)).toBe(true);
  });

  it("常駐でないプリンターは従来どおり掃除される", async () => {
    let clock = 1_000;
    const sessions = managerWithClock(() => clock, 60_000);
    const entry = await open(sessions, {});
    clock += 10 * 60_000;
    sweep(sessions);
    expect(sessions.listPrinters().some((e) => e.id === entry.id)).toBe(false);
  });
});

describe("上限", () => {
  it("常駐は表示セッションの枠を食わない（帳票を待たせて画面が開けなくならない）", async () => {
    // 表示の上限を 1 にしても、常駐プリンターがあるだけでは埋まらない
    const sessions = new SessionManager({ maxSessions: 1 });
    await open(sessions, { service: true });
    expect(sessions.size).toBe(0);
  });

  it("常駐でないプリンターは表示の枠を食う（従来どおり）", async () => {
    const sessions = new SessionManager({ maxSessions: 1 });
    await open(sessions, {});
    expect(sessions.size).toBe(1);
    await expect(open(sessions, {})).rejects.toMatchObject({ code: "SESSION_LIMIT" });
  });

  it("常駐にも上限がある（無制限に張らせない）", async () => {
    const sessions = new SessionManager({ maxResidentPrinters: 2 });
    await open(sessions, { service: true });
    await open(sessions, { service: true });
    await expect(open(sessions, { service: true })).rejects.toMatchObject({ code: "SESSION_LIMIT" });
  });

  it("常駐の上限に既定がある", () => {
    expect(DEFAULT_MAX_RESIDENT_PRINTERS).toBe(4);
  });
});
