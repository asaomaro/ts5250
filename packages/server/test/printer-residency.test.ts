import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, DEFAULT_MAX_RESIDENT_PRINTERS } from "../src/session-manager.js";
import type { Transport } from "@ts5250/tn5250";

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
  opts: { service?: boolean; output?: boolean; autoStart?: boolean } = {}
) {
  const dir = join(mkdtempSync(join(tmpdir(), "prt-")), "out");
  return sessions.openPrinter({
    ...(opts.service ? { service: true } : {}),
    ...(opts.output ? { output: { autoPdfDir: dir } } : {}),
    ...(opts.autoStart !== undefined ? { autoStart: opts.autoStart } : {}),
    // **開き直しでも同じ偽の接続を返す**（開始/停止の往復を試すため）
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

describe("開始と停止", () => {
  it("既定では開いた直後から待ち受ける（いままでどおり）", async () => {
    const sessions = new SessionManager();
    const entry = await open(sessions);
    expect(entry.state).toBe("listening");
    expect(entry.session).toBeDefined();
  });

  it("**autoStart ☐ なら開いても待ち受けない**（開始操作を待つ）", async () => {
    const sessions = new SessionManager();
    const entry = await open(sessions, { autoStart: false });
    expect(entry.state).toBe("stopped");
    // 接続を持たない——「開く（登録する）」と「待ち受ける」は別
    expect(entry.session).toBeUndefined();
  });

  it("停止しても**一覧に残る**（消すと画面から再開できない）", async () => {
    const sessions = new SessionManager();
    const entry = await open(sessions);
    sessions.stopPrinter(entry.id);
    expect(entry.state).toBe("stopped");
    expect(sessions.listPrinters().some((e) => e.id === entry.id)).toBe(true);
  });

  it("停止で接続を手放す（掴んだまま受け取らないと他の人が使えない）", async () => {
    const sessions = new SessionManager();
    const entry = await open(sessions);
    sessions.stopPrinter(entry.id);
    expect(entry.session).toBeUndefined();
  });

  it("停止したものを再開できる", async () => {
    const sessions = new SessionManager();
    const entry = await open(sessions, { autoStart: false });
    await sessions.startPrinter(entry.id);
    expect(entry.state).toBe("listening");
    expect(entry.session).toBeDefined();
  });

  it("開始も停止も冪等（画面から二重に押されても壊れない）", async () => {
    const sessions = new SessionManager();
    const entry = await open(sessions);
    await sessions.startPrinter(entry.id); // 既に listening
    expect(entry.state).toBe("listening");
    sessions.stopPrinter(entry.id);
    sessions.stopPrinter(entry.id); // 二度目
    expect(entry.state).toBe("stopped");
  });

  it("**停止中は上限を食わない**（登録しただけで自分を締め出さない）", async () => {
    const sessions = new SessionManager({ maxSessions: 1 });
    const a = await open(sessions);
    expect(sessions.size).toBe(1);
    sessions.stopPrinter(a.id);
    expect(sessions.size).toBe(0);
    // 空いたので別のを開ける
    await open(sessions);
  });

  it("状態の変化がフックで届く（黙って止まらない）", async () => {
    const sessions = new SessionManager();
    const seen: string[] = [];
    const entry = await open(sessions, { autoStart: false });
    entry.onState = (s) => void seen.push(s.state);
    await sessions.startPrinter(entry.id);
    sessions.stopPrinter(entry.id);
    expect(seen).toEqual(["listening", "stopped"]);
  });
});

describe("開き直したら既存へ繋ぐ（attach）", () => {
  /** `ref` 付きで開く（保存済み設定由来の経路） */
  const openRef = (sessions: SessionManager, ref: string, owner?: string) =>
    sessions.openPrinter({
      ref,
      ...(owner !== undefined ? { owner } : {}),
      service: true,
      transport: transport()
    });

  it("**同じ ref を二度開いても 1 本**（装置名はホスト上で排他）", async () => {
    const sessions = new SessionManager();
    const a = await openRef(sessions, "srv:prt1");
    const b = await openRef(sessions, "srv:prt1");
    expect(b.id).toBe(a.id);
    expect(sessions.listPrinters()).toHaveLength(1);
  });

  it("**attach では状態を変えない**（止めたものを開き直しただけで再開しない）", async () => {
    const sessions = new SessionManager();
    const a = await openRef(sessions, "srv:prt1");
    sessions.stopPrinter(a.id);
    const b = await openRef(sessions, "srv:prt1");
    expect(b.id).toBe(a.id);
    expect(b.state).toBe("stopped");
  });

  it("所有が違えば繋がない（他人の常駐に相乗りしない）", async () => {
    const sessions = new SessionManager();
    const a = await openRef(sessions, "srv:prt1", "alice");
    const b = await openRef(sessions, "srv:prt1", "bob");
    expect(b.id).not.toBe(a.id);
  });

  it("ref が無ければ従来どおり毎回新規（直接接続）", async () => {
    const sessions = new SessionManager();
    const a = await open(sessions);
    const b = await open(sessions);
    expect(b.id).not.toBe(a.id);
  });
});

describe("帳票バッファの上限", () => {
  /** `deliverReport` は private。常駐が何日も動く前提の歯止めを直接確かめる */
  const deliver = (sessions: SessionManager, entry: { id: string }, n: number): void => {
    const m = sessions as unknown as {
      deliverReport: (e: unknown, r: unknown) => void;
    };
    const e = sessions.listPrinters().find((x) => x.id === entry.id)!;
    for (let i = 0; i < n; i++) m.deliverReport(e, { id: `s${i}`, pages: [] });
  };

  it("上限を超えたら古いものから落ちる（常駐は無制限にできない）", async () => {
    const sessions = new SessionManager();
    const entry = await open(sessions);
    deliver(sessions, entry, 60);
    expect(entry.reports.length).toBe(50);
    // 落ちたのは古い方——新しいものが残る
    expect(entry.reports[entry.reports.length - 1]?.id).toBe("s59");
  });

  it("累計は落ちた分も数える（何件来たかを見失わない）", async () => {
    const sessions = new SessionManager();
    const entry = await open(sessions);
    deliver(sessions, entry, 60);
    expect(entry.receivedTotal).toBe(60);
  });

  it("落としたぶん `delivered` もずらす（渡した位置が壊れない）", async () => {
    const sessions = new SessionManager();
    const entry = await open(sessions);
    deliver(sessions, entry, 60);
    // 位置が配列の外を指していない
    expect(entry.delivered).toBeGreaterThanOrEqual(0);
    expect(entry.delivered).toBeLessThanOrEqual(entry.reports.length);
  });
});
