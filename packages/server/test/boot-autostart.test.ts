import { describe, it, expect } from "vitest";
import { startAutoServices } from "../src/boot-autostart.js";
import type { ConfigResolver } from "../src/config-resolver.js";
import type { SessionManager } from "../src/session-manager.js";
import type { WatchRegistry } from "../src/watch-registry.js";
import type { PublicSession } from "../src/config-types.js";

/**
 * **サーバー起動時の自動開始**（`20260801-boot-autostart`）。
 *
 * ここが入って初めて「サーバー」になる——これまでは「一度開いたら残る」までで、
 * **プロセスを再起動すると何も動いていなかった**。
 *
 * 立ち上げるのは**サーバー設定の定義だけ**。個人設定は所有者のものなので、
 * **本人が居ない起動時にその人として繋ぎに行かない**。
 */
const def = (over: Partial<PublicSession> & { ref: string; sessionType: PublicSession["sessionType"] }): PublicSession =>
  ({ name: over.ref, system: "srv:s1", ...over }) as PublicSession;

function deps(opts: {
  defs: PublicSession[];
  openPrinter?: (o: Record<string, unknown>) => Promise<unknown>;
  startWatch?: (o: Record<string, unknown>) => Promise<unknown>;
  withWatches?: boolean;
}) {
  const openedPrinters: Record<string, unknown>[] = [];
  const startedWatches: Record<string, unknown>[] = [];
  const resolver = {
    listSessions: () => opts.defs,
    resolve: (r: { session: string }) => ({
      connect: { host: "h" },
      source: "server",
      system: {},
      autoStart: true,
      session: { sessionType: "dtaqwatch", dtaqWatch: { library: "L", name: "Q" } },
      printerOutput: { autoPdfDir: "/tmp/x" },
      ref: r.session
    })
  } as unknown as ConfigResolver;
  const sessions = {
    openPrinter: async (o: Record<string, unknown>) => {
      openedPrinters.push(o);
      return opts.openPrinter ? opts.openPrinter(o) : {};
    }
  } as unknown as SessionManager;
  const watches = {
    start: async (o: Record<string, unknown>) => {
      startedWatches.push(o);
      return opts.startWatch ? opts.startWatch(o) : {};
    }
  } as unknown as WatchRegistry;
  return {
    d: { resolver, sessions, ...(opts.withWatches === false ? {} : { watches }) },
    openedPrinters,
    startedWatches
  };
}

describe("何を立ち上げるか", () => {
  it("サービス ✅ のプリンター定義を立ち上げる", async () => {
    const { d, openedPrinters } = deps({
      defs: [def({ ref: "srv:p1", sessionType: "printer", service: true })]
    });
    const r = await startAutoServices(d);
    expect(r.started).toBe(1);
    expect(openedPrinters[0]).toMatchObject({ ref: "srv:p1", service: true });
  });

  it("**サービス ☐ のプリンターは上げない**（対話型は人が開くもの）", async () => {
    const { d, openedPrinters } = deps({ defs: [def({ ref: "srv:p1", sessionType: "printer" })] });
    const r = await startAutoServices(d);
    expect(r.started).toBe(0);
    expect(openedPrinters).toEqual([]);
  });

  it("**自動で待ち受け開始 ☐ は上げない**（開始ボタンを待つ）", async () => {
    const { d } = deps({
      defs: [def({ ref: "srv:p1", sessionType: "printer", service: true, autoStart: false })]
    });
    expect((await startAutoServices(d)).started).toBe(0);
  });

  it("**個人設定は上げない**（本人が居ない起動時にその人として繋がない）", async () => {
    const { d } = deps({
      defs: [def({ ref: "own:p1", sessionType: "printer", service: true })]
    });
    const r = await startAutoServices(d);
    expect(r.started).toBe(0);
    expect(r.skipped).toBe(1);
  });

  it("`dtaqwatch` は種別そのものがサービス型なので `service` を見ない", async () => {
    const { d, startedWatches } = deps({ defs: [def({ ref: "srv:w1", sessionType: "dtaqwatch" })] });
    const r = await startAutoServices(d);
    expect(r.started).toBe(1);
    expect(startedWatches[0]).toMatchObject({ ref: "srv:w1", label: "L/Q" });
  });

  it("display は対象外", async () => {
    const { d } = deps({ defs: [def({ ref: "srv:d1", sessionType: "display" })] });
    expect((await startAutoServices(d)).started).toBe(0);
  });
});

describe("失敗しても起動を止めない", () => {
  it("1 台が失敗しても残りは立ち上がる（設定ミスで全部止めない）", async () => {
    const { d, openedPrinters } = deps({
      defs: [
        def({ ref: "srv:bad", sessionType: "printer", service: true }),
        def({ ref: "srv:good", sessionType: "printer", service: true })
      ],
      openPrinter: async (o) => {
        if (o.ref === "srv:bad") throw new Error("host unreachable");
        return {};
      }
    });
    const r = await startAutoServices(d);
    expect(r.started).toBe(1);
    expect(r.failed).toEqual([{ ref: "srv:bad", error: "host unreachable" }]);
    // 失敗の後も次へ進んでいる
    expect(openedPrinters.map((o) => o.ref)).toEqual(["srv:bad", "srv:good"]);
  });

  it("**例外を投げ返さない**（起動を巻き添えにしない）", async () => {
    const { d } = deps({
      defs: [def({ ref: "srv:bad", sessionType: "printer", service: true })],
      openPrinter: async () => {
        throw new Error("boom");
      }
    });
    await expect(startAutoServices(d)).resolves.toMatchObject({ started: 0 });
  });

  it("監視レジストリが無ければ `dtaqwatch` は飛ばす（落ちない）", async () => {
    const { d } = deps({
      defs: [def({ ref: "srv:w1", sessionType: "dtaqwatch" })],
      withWatches: false
    });
    const r = await startAutoServices(d);
    expect(r.started).toBe(0);
    expect(r.skipped).toBe(1);
  });
});
