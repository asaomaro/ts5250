import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { registerHostPrinterRoutes } from "../src/host-printers.js";
import type { AuthVars } from "../src/auth.js";
import type { ConfigResolver } from "../src/config-resolver.js";
import type { PrinterEntry, SessionManager } from "../src/session-manager.js";
import type { WatchRegistry, WatchView } from "../src/watch-registry.js";
import type { ServiceDef } from "../src/config-types.js";

/**
 * **定義ベースの一覧**（`20260801-definition-based-listing`）。
 *
 * 実行中だけを並べると、**サービス ✅ ＋ 自動で待ち受け開始 ☐** の定義が
 * 画面に出ず「開始」を押せない——永久に起動できなくなる。
 * だから**定義が行**で、動いていなければ `stopped` として出す。
 */
const def = (over: Partial<ServiceDef> & { ref: string; sessionType: ServiceDef["sessionType"] }): ServiceDef =>
  ({ name: over.ref, ...over }) as ServiceDef;

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
  defs?: ServiceDef[];
  printers?: PrinterEntry[];
  watches?: WatchView[];
  history?: number;
  /** 操作できる相手か（＝サーバー設定を編集できるか）。既定は編集できる */
  editable?: boolean;
}) {
  const resolver = { listServiceDefs: () => opts.defs ?? [] } as unknown as ConfigResolver;
  const sessions = { listPrinters: () => opts.printers ?? [] } as unknown as SessionManager;
  const watches = {
    list: () => opts.watches ?? [],
    history: () => new Array(opts.history ?? 0).fill({})
  } as unknown as WatchRegistry;
  const app = new Hono<{ Variables: AuthVars }>();
  registerHostPrinterRoutes(app, { resolver, sessions, watches, canEditServer: () => opts.editable !== false });
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

/**
 * **見るだけは許す**（`20260801-services-pane`・利用者の判断）。
 *
 * 一覧そのものは誰にでも返す——帳票が来ない理由が「止まっているから」なら、
 * それが分からないと問い合わせるしかない。ただし**理由の文面はパスを含みうる**ので、
 * `error` と `warnings` は操作できる相手（サーバー設定を編集できる相手）にだけ。
 */
describe("操作できない相手への出し分け", () => {
  it("**状態は見える**（動いているかどうかは分かる）", async () => {
    const app = appWith({
      editable: false,
      defs: [def({ ref: "srv:p1", sessionType: "printer", service: true })],
      printers: [entry({ id: "e1", ref: "srv:p1", receivedTotal: 3 })]
    });
    const body = await get(app, "/api/printers");
    expect(body.printers[0]).toMatchObject({ state: "listening", receivedTotal: 3 });
    expect(body.editable).toBe(false);
  });

  it("**失敗の理由は出さない**（文面にサーバーのパスが載りうる）", async () => {
    const app = appWith({
      editable: false,
      defs: [def({ ref: "srv:p1", sessionType: "printer" })],
      printers: [
        entry({
          id: "e1",
          ref: "srv:p1",
          state: "error",
          error: "device PRT1 in use",
          outputWarnings: [{ at: 1, message: "/var/secret/out に書けません" }]
        })
      ]
    });
    const body = await get(app, "/api/printers");
    // 状態は出る（止まっていることは分かる）
    expect(body.printers[0]!.state).toBe("error");
    expect(body.printers[0]!.error).toBeUndefined();
    expect(body.printers[0]!.warnings).toBeUndefined();
    expect(JSON.stringify(body.printers[0])).not.toContain("/var/secret/out");
  });

  it("監視も同じ（理由は出さないが受信数は出る）", async () => {
    const app = appWith({
      editable: false,
      defs: [def({ ref: "srv:w1", sessionType: "dtaqwatch" })],
      watches: [view({ id: "w1", ref: "srv:w1", state: "error", error: "not authorized", received: 4 })],
      history: 5
    });
    const body = await get(app, "/api/watches");
    expect(body.watches[0]).toMatchObject({ state: "error", received: 4 });
    expect(body.watches[0]!.error).toBeUndefined();
    // 履歴の件数は所有者にしか数えられない（`history` が所有者を検査して投げる）
    expect(body.watches[0]!.buffered).toBeUndefined();
  });

  it("操作できる相手には従来どおり理由が出る", async () => {
    const app = appWith({
      defs: [def({ ref: "srv:p1", sessionType: "printer" })],
      printers: [entry({ id: "e1", ref: "srv:p1", state: "error", error: "device in use" })]
    });
    const body = await get(app, "/api/printers");
    expect(body.printers[0]!.error).toBe("device in use");
    expect(body.editable).toBe(true);
  });
});
