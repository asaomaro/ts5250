import { describe, it, expect } from "vitest";
import { reconcileService } from "../src/service-reconcile.js";
import type { ConfigResolver } from "../src/config-resolver.js";
import type { PrinterEntry, SessionManager } from "../src/session-manager.js";
import type { WatchRegistry, WatchView } from "../src/watch-registry.js";

/**
 * **定義の変更を動いているサービスに反映する**（`20260801-service-reconcile`）。
 *
 * `20260801-boot-autostart` は起動時に 1 回だけ読むので、定義を足しても上がらず、
 * 消しても動き続け、直しても古い設定のままだった。
 *
 * **動いているものは落とさない**のが軸。名前の打ち間違いを直しただけで
 * 帳票の受け取りが切れるのは割に合わないので、`stale` を立てて利用者に止めどきを委ねる。
 */
function deps(opts: {
  /** 解決結果（省略＝サービス ✅ ＋ 自動 ✅ のプリンター） */
  target?: Record<string, unknown>;
  printers?: PrinterEntry[];
  watches?: WatchView[];
  /** `updatePrinterOptions` / `watches.update` の戻り（＝いま接続を持っているか） */
  running?: boolean;
  noWatches?: boolean;
}) {
  const calls: string[] = [];
  const resolver = {
    resolve: () =>
      opts.target ?? {
        connect: { host: "h" },
        source: "server",
        system: {},
        autoStart: true,
        service: true,
        session: { sessionType: "printer" }
      }
  } as unknown as ConfigResolver;
  const sessions = {
    listPrinters: () => opts.printers ?? [],
    openPrinter: async (o: Record<string, unknown>) => {
      calls.push(`openPrinter autoStart=${String(o.autoStart)}`);
      return {};
    },
    stopPrinter: (id: string) => calls.push(`stopPrinter ${id}`),
    close: async (id: string) => calls.push(`close ${id}`),
    updatePrinterOptions: (id: string) => {
      calls.push(`updatePrinterOptions ${id}`);
      return opts.running === true;
    }
  } as unknown as SessionManager;
  const watches = {
    list: () => opts.watches ?? [],
    start: async () => calls.push("watch.start"),
    stop: (id: string) => calls.push(`watch.stop ${id}`),
    remove: (id: string) => calls.push(`watch.remove ${id}`),
    update: (id: string) => {
      calls.push(`watch.update ${id}`);
      return opts.running === true;
    }
  } as unknown as WatchRegistry;
  return {
    d: { resolver, sessions, ...(opts.noWatches ? {} : { watches }) },
    calls
  };
}

const printerTarget = (over: Record<string, unknown> = {}) => ({
  connect: { host: "h" },
  source: "server",
  system: {},
  autoStart: true,
  service: true,
  session: { sessionType: "printer" },
  ...over
});
const watchTarget = (over: Record<string, unknown> = {}) => ({
  connect: { host: "h" },
  source: "server",
  system: {},
  autoStart: true,
  session: { sessionType: "dtaqwatch", dtaqWatch: { library: "L", name: "Q" } },
  ...over
});

describe("定義が足された", () => {
  it("サービス ✅ ＋ 自動 ✅ なら立ち上げる", async () => {
    const { d, calls } = deps({});
    expect(await reconcileService(d, "srv:p1", "saved")).toMatchObject({ started: true });
    expect(calls).toEqual(["openPrinter autoStart=true"]);
  });

  it("**自動で待ち受け開始 ☐ なら登録だけ**（開始ボタンを待つ約束は保存でも変わらない）", async () => {
    const { d, calls } = deps({ target: printerTarget({ autoStart: false }) });
    expect(await reconcileService(d, "srv:p1", "saved")).toMatchObject({ started: false });
    expect(calls).toEqual(["openPrinter autoStart=false"]);
  });

  it("サービス ☐ のプリンターは上げない（対話型は人が開くもの）", async () => {
    const { d, calls } = deps({ target: printerTarget({ service: false }) });
    expect(await reconcileService(d, "srv:p1", "saved")).toMatchObject({ skipped: "サービスではない" });
    expect(calls).toEqual([]);
  });

  it("`dtaqwatch` は `service` を見ない（種別そのものがサービス型）", async () => {
    const { d, calls } = deps({ target: watchTarget() });
    expect(await reconcileService(d, "srv:w1", "saved")).toMatchObject({ started: true });
    expect(calls).toEqual(["watch.start"]);
  });

  it("**個人設定は扱わない**（本人が居ないところでその人として繋がない）", async () => {
    const { d, calls } = deps({});
    expect(await reconcileService(d, "own:p1", "saved")).toMatchObject({ skipped: "個人設定" });
    expect(calls).toEqual([]);
  });
});

describe("定義が直された", () => {
  const entry = { id: "e1", ref: "srv:p1" } as PrinterEntry;

  it("**動いているものは落とさず、材料だけ差し替える**", async () => {
    const { d, calls } = deps({ printers: [entry], running: true });
    expect(await reconcileService(d, "srv:p1", "saved")).toEqual({ stale: true });
    // 止めていない——保存の副作用で帳票の受け取りが切れない
    expect(calls).toEqual(["updatePrinterOptions e1"]);
  });

  it("止まっているものは `stale` にしない（次の開始で新しい設定が効く）", async () => {
    const { d } = deps({ printers: [entry], running: false });
    expect(await reconcileService(d, "srv:p1", "saved")).toEqual({});
  });

  it("**サービス ☐ に変えたら止める**（常駐の意図が取り消された）", async () => {
    const { d, calls } = deps({ target: printerTarget({ service: false }), printers: [entry] });
    expect(await reconcileService(d, "srv:p1", "saved")).toMatchObject({ stopped: true });
    expect(calls).toEqual(["stopPrinter e1", "close e1"]);
  });

  it("監視も同じ（落とさず差し替え）", async () => {
    const { d, calls } = deps({
      target: watchTarget(),
      watches: [{ id: "w1", ref: "srv:w1" } as WatchView],
      running: true
    });
    expect(await reconcileService(d, "srv:w1", "saved")).toEqual({ stale: true });
    expect(calls).toEqual(["watch.update w1"]);
  });
});

describe("定義が消された", () => {
  it("**動いているプリンターを止めて捨てる**（定義の無いサービスは残さない）", async () => {
    const { d, calls } = deps({ printers: [{ id: "e1", ref: "srv:p1" } as PrinterEntry] });
    expect(await reconcileService(d, "srv:p1", "removed")).toMatchObject({ stopped: true });
    expect(calls).toEqual(["stopPrinter e1", "close e1"]);
  });

  it("監視も止めて消す（**先に stop**——接続を持ったまま消すと装置が返らない）", async () => {
    const { d, calls } = deps({ watches: [{ id: "w1", ref: "srv:w1" } as WatchView] });
    expect(await reconcileService(d, "srv:w1", "removed")).toMatchObject({ stopped: true });
    expect(calls).toEqual(["watch.stop w1", "watch.remove w1"]);
  });

  it("動いていなければ何もしない", async () => {
    const { d } = deps({});
    expect(await reconcileService(d, "srv:p1", "removed")).toMatchObject({ skipped: "動いていない" });
  });

  it("**消えた定義を解決しに行かない**（解決は必ず失敗するので、行けば必ず例外になる）", async () => {
    const resolver = {
      resolve: () => {
        throw new Error("session not found");
      }
    } as unknown as ConfigResolver;
    const sessions = { listPrinters: () => [] } as unknown as SessionManager;
    const r = await reconcileService({ resolver, sessions }, "srv:gone", "removed");
    expect(r.skipped).toBe("動いていない"); // 解決に触れていない
  });
});

describe("失敗しても呼び出し元を巻き添えにしない", () => {
  it("**投げない**（設定は保存できているのに 500 を返さない）", async () => {
    const resolver = {
      resolve: () => {
        throw new Error("host unreachable");
      }
    } as unknown as ConfigResolver;
    const sessions = { listPrinters: () => [] } as unknown as SessionManager;
    await expect(reconcileService({ resolver, sessions }, "srv:p1", "saved")).resolves.toMatchObject({
      skipped: "host unreachable"
    });
  });

  it("監視レジストリが無ければ飛ばす（落ちない）", async () => {
    const { d } = deps({ target: watchTarget(), noWatches: true });
    expect(await reconcileService(d, "srv:w1", "saved")).toMatchObject({ skipped: "監視レジストリが無い" });
  });
});
