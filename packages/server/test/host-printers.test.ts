import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { registerHostPrinterRoutes } from "../src/host-printers.js";
import type { AuthVars } from "../src/auth.js";
import type { ConfigResolver } from "../src/config-resolver.js";
import type { PrinterEntry, SessionManager } from "../src/session-manager.js";
import type { WatchRegistry, WatchView } from "../src/watch-registry.js";
import type { PublicSession } from "../src/config-types.js";

/**
 * **定義ベースの一覧**（`20260801-definition-based-listing`）。
 *
 * 実行中だけを並べると、**サービス ✅ ＋ 自動で待ち受け開始 ☐** の定義が
 * 画面に出ず「開始」を押せない——永久に起動できなくなる。
 * だから**定義が行**で、動いていなければ `stopped` として出す。
 */
const def = (over: Partial<PublicSession> & { ref: string; sessionType: PublicSession["sessionType"] }): PublicSession =>
  ({ name: over.ref, system: "srv:s1", ...over }) as PublicSession;

const entry = (over: Partial<PrinterEntry> & { id: string }): PrinterEntry =>
  ({
    host: "h",
    origin: "profile",
    connectedAt: "2026-08-01T00:00:00.000Z",
    lastActivity: 0,
    state: "listening",
    openOpts: {},
    reports: [],
    receivedTotal: 0,
    delivered: 0,
    waiters: [],
    outputEnabled: true,
    outputWarnings: [],
    outputStatuses: [],
    resident: false,
    ...over
  }) as PrinterEntry;

const view = (over: Partial<WatchView> & { id: string; ref: string }): WatchView =>
  ({
    kind: "dtaq",
    label: "MYLIB/Q",
    state: "listening",
    received: 0,
    startedAt: "2026-08-01T00:00:00.000Z",
    ...over
  }) as WatchView;

function appWith(opts: {
  defs?: PublicSession[];
  printers?: PrinterEntry[];
  watches?: WatchView[];
  history?: number;
}) {
  const resolver = { listSessions: () => opts.defs ?? [] } as unknown as ConfigResolver;
  const sessions = { listPrinters: () => opts.printers ?? [] } as unknown as SessionManager;
  const watches = {
    list: () => opts.watches ?? [],
    history: () => new Array(opts.history ?? 0).fill({})
  } as unknown as WatchRegistry;
  const app = new Hono<{ Variables: AuthVars }>();
  registerHostPrinterRoutes(app, { resolver, sessions, watches });
  return app;
}

const get = async (app: Hono<{ Variables: AuthVars }>, path: string) =>
  (await app.request(path)).json() as Promise<Record<string, Record<string, unknown>[]>>;

describe("GET /api/printers（定義ベース）", () => {
  it("**一度も開いていない定義も出る**（出ないと開始を押せない）", async () => {
    const app = appWith({ defs: [def({ ref: "srv:p1", sessionType: "printer", service: true })] });
    const body = await get(app, "/api/printers");
    expect(body.printers).toHaveLength(1);
    expect(body.printers[0]).toMatchObject({ ref: "srv:p1", state: "stopped", service: true });
    // 動いていないので実体の id は無い
    expect(body.printers[0]!.id).toBeUndefined();
  });

  it("動いている定義には状態と実績が添う", async () => {
    const app = appWith({
      defs: [def({ ref: "srv:p1", sessionType: "printer" })],
      printers: [entry({ id: "e1", ref: "srv:p1", receivedTotal: 7, reports: [{}, {}] as PrinterEntry["reports"] })]
    });
    const body = await get(app, "/api/printers");
    expect(body.printers[0]).toMatchObject({
      state: "listening",
      id: "e1",
      receivedTotal: 7,
      buffered: 2
    });
  });

  it("警告は新しい順（溜まった古い失敗より今を先に）", async () => {
    const app = appWith({
      defs: [def({ ref: "srv:p1", sessionType: "printer" })],
      printers: [
        entry({
          id: "e1",
          ref: "srv:p1",
          outputWarnings: [
            { at: 1, message: "古い" },
            { at: 2, message: "新しい" }
          ]
        })
      ]
    });
    const body = await get(app, "/api/printers");
    expect(body.printers[0]!.warnings).toEqual([
      { at: 2, message: "新しい" },
      { at: 1, message: "古い" }
    ]);
  });

  it("**直接接続（定義なし）は出ない**（サービスの一覧であってセッションの一覧ではない）", async () => {
    const app = appWith({
      defs: [],
      printers: [entry({ id: "direct" })] // ref なし
    });
    const body = await get(app, "/api/printers");
    expect(body.printers).toEqual([]);
  });

  it("printer 以外の定義は出ない", async () => {
    const app = appWith({
      defs: [def({ ref: "srv:d1", sessionType: "display" }), def({ ref: "srv:w1", sessionType: "dtaqwatch" })]
    });
    expect((await get(app, "/api/printers")).printers).toEqual([]);
  });

  it("信頼設定の中身は出さない（持っているかだけ）", async () => {
    const app = appWith({ defs: [def({ ref: "srv:p1", sessionType: "printer", hasOutput: true })] });
    const body = await get(app, "/api/printers");
    expect(body.printers[0]).toMatchObject({ hasOutput: true });
    // パスもプリンター名も行に載っていない
    expect(JSON.stringify(body.printers[0])).not.toMatch(/autoPdfDir|autoPrint|\//);
  });

  it("autoStart は未設定なら true（いまある定義の挙動を変えない）", async () => {
    const app = appWith({
      defs: [def({ ref: "srv:p1", sessionType: "printer" }), def({ ref: "srv:p2", sessionType: "printer", autoStart: false })]
    });
    const body = await get(app, "/api/printers");
    expect(body.printers.map((p) => p.autoStart)).toEqual([true, false]);
  });
});

describe("GET /api/watches（定義ベース）", () => {
  it("一度も開いていない `dtaqwatch` 定義も `stopped` で出る", async () => {
    const app = appWith({ defs: [def({ ref: "srv:w1", sessionType: "dtaqwatch" })] });
    const body = await get(app, "/api/watches");
    expect(body.watches[0]).toMatchObject({ ref: "srv:w1", state: "stopped", service: true });
  });

  it("動いている監視には状態と件数が添う（**本文は載せない**）", async () => {
    const app = appWith({
      defs: [def({ ref: "srv:w1", sessionType: "dtaqwatch" })],
      watches: [view({ id: "w1", ref: "srv:w1", received: 12, label: "MYLIB/ORDERQ" })],
      history: 5
    });
    const body = await get(app, "/api/watches");
    expect(body.watches[0]).toMatchObject({ id: "w1", received: 12, buffered: 5, label: "MYLIB/ORDERQ" });
    expect(JSON.stringify(body.watches[0])).not.toContain("text");
  });

  it("待ち行列は種別そのものがサービス型（常に service）", async () => {
    const app = appWith({ defs: [def({ ref: "srv:w1", sessionType: "dtaqwatch" })] });
    expect((await get(app, "/api/watches")).watches[0]!.service).toBe(true);
  });

  it("error の理由が出る（黙って止まらない）", async () => {
    const app = appWith({
      defs: [def({ ref: "srv:w1", sessionType: "dtaqwatch" })],
      watches: [view({ id: "w1", ref: "srv:w1", state: "error", error: "not authorized" })]
    });
    expect((await get(app, "/api/watches")).watches[0]).toMatchObject({
      state: "error",
      error: "not authorized"
    });
  });
});
