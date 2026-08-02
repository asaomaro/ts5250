import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import type { PublicSession, PublicSystem } from "@as400web/server";

/**
 * **サービス一覧から帳票を読みに行けること**（`20260802-printer-report-history`）。
 *
 * 一覧は `帳票 12 件（保持 10）` と出すのに、**そこから開く道が無かった**。
 * 「あると書いてあるのに読めない」は「無い」より悪い。
 *
 * 開く処理は `openConfigured`（ランチャーと共用）を通す——「開いていればタブへ戻す」
 * 判断を 2 か所に持たないため。ここではその配線と、**読むのは admin に限らない**ことを固定する。
 */
const openPrinterSession = vi.fn((...args: unknown[]): Promise<string> => {
  void args;
  return Promise.resolve("prt-1");
});
const openSession = vi.fn((...args: unknown[]): Promise<string> => {
  void args;
  return Promise.resolve("s-1");
});
vi.mock("../src/session-controller.js", () => ({
  openPrinterSession: (...a: unknown[]) => openPrinterSession(...a),
  openSession: (...a: unknown[]) => openSession(...a)
}));

import ServicesPane from "../src/components/ServicesPane.vue";
import { servicesStore } from "../src/stores/services.js";
import { systemsStore } from "../src/stores/systems.js";
import { sessionsStore, type SessionState } from "../src/stores/sessions.js";
import { workspaceStore } from "../src/stores/workspace.js";
import { useOpenConfigured } from "../src/composables/openConfigured.js";

const SYSTEM: PublicSystem = { ref: "srv:sys", name: "AS400", host: "h", autoSignon: false };
const PRINTER_DEF: PublicSession = {
  ref: "srv:p",
  name: "帳票",
  system: "srv:sys",
  sessionType: "printer",
  deviceName: "PRT_TEST"
} as PublicSession;

const PRINTER_ROW = {
  ref: "srv:p",
  name: "帳票",
  state: "listening",
  service: true,
  autoStart: true,
  hasOutput: false,
  id: "prt-1",
  receivedTotal: 12,
  buffered: 10
};

function stubFetch(editable = false): void {
  vi.stubGlobal("fetch", (url: string) => {
    const u = String(url);
    if (u === "/api/printers") {
      return Promise.resolve(new Response(JSON.stringify({ printers: [PRINTER_ROW], editable }), { status: 200 }));
    }
    if (u === "/api/watches") {
      return Promise.resolve(new Response(JSON.stringify({ watches: [], editable }), { status: 200 }));
    }
    return Promise.resolve(new Response("{}", { status: 200 }));
  });
}

/** 一覧だけ用意する（`open()` は WS とポーリングを始めるので使わない） */
async function seed(editable = false): Promise<void> {
  stubFetch(editable);
  await servicesStore.refresh();
}

async function mountPane() {
  const w = mount(ServicesPane, { props: { tabId: "svc:services", active: false } });
  await flushPromises();
  return w;
}

const openButton = (w: Awaited<ReturnType<typeof mountPane>>) =>
  w.findAll("button").find((b) => b.text() === "開く");

beforeEach(() => {
  openPrinterSession.mockClear();
  openSession.mockClear();
  systemsStore.systems = [SYSTEM];
  systemsStore.sessions = [PRINTER_DEF];
  systemsStore.loaded = true;
  sessionsStore.byId.clear();
  sessionsStore.order = [];
  workspaceStore.init();
  useOpenConfigured().error.value = "";
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("サービス一覧から帳票を開く", () => {
  it("プリンターの行に `開く` が出る", async () => {
    await seed();
    const w = await mountPane();
    expect(openButton(w)).toBeTruthy();
    w.unmount();
  });

  it("押すとそのプリンターが開く（帳票は `printer-opened` で届く）", async () => {
    await seed();
    const w = await mountPane();
    await openButton(w)!.trigger("click");
    await flushPromises();
    expect(openPrinterSession).toHaveBeenCalledTimes(1);
    expect(openPrinterSession.mock.calls[0]?.[0]).toMatchObject({ kind: "printer", session: "srv:p" });
    w.unmount();
  });

  it("**操作できない利用者にも出す**——読むだけなので admin に限らない", async () => {
    await seed(false);
    const w = await mountPane();
    // 開始/停止は出ない（admin だけ）が、`開く` は出る
    expect(w.findAll("button").some((b) => b.text() === "停止")).toBe(false);
    expect(openButton(w)).toBeTruthy();
    w.unmount();
  });

  it("**既に開いていれば 2 本目を開かず、そのタブへ移る**", async () => {
    await seed();
    sessionsStore.add({
      sessionId: "prt-1",
      label: "帳票",
      kind: "printer",
      configRef: "srv:p",
      snapshot: undefined,
      edits: new Map(),
      cursor: { row: 1, col: 1 },
      connected: true,
      readOnly: true,
      reports: [],
      client: {} as SessionState["client"]
    } as SessionState);
    workspaceStore.addSession("prt-1", "srv:sys");
    workspaceStore.addSession("svc:services");
    const w = await mountPane();
    await openButton(w)!.trigger("click");
    await flushPromises();
    expect(openPrinterSession).not.toHaveBeenCalled();
    expect(workspaceStore.focusedGroup().activeTab).toBe("prt-1");
    w.unmount();
  });

  it("セッション設定が引けなければ出さない（押しても始まらないボタンを置かない）", async () => {
    await seed();
    systemsStore.sessions = [];
    const w = await mountPane();
    expect(openButton(w)).toBeUndefined();
    w.unmount();
  });

  it("開く途中の失敗は一覧の失敗と同じ行に出す（通知先を増やさない）", async () => {
    await seed();
    openPrinterSession.mockRejectedValueOnce(new Error("装置が使用中です"));
    const w = await mountPane();
    await openButton(w)!.trigger("click");
    await flushPromises();
    expect(w.text()).toContain("装置が使用中です");
    w.unmount();
  });

  it("**ランチャーで出た失敗を持ち越さない**（見えるようになった時点で捨てる）", async () => {
    await seed();
    // 開く処理の失敗はランチャーと共有の ref。持ち越すと、開いた瞬間に無関係な文面が出る
    useOpenConfigured().error.value = "装置名 X は「別のタブ」が使用中です。";
    // WS を掴ませない（`servicesStore.open()` が張りに行く）
    vi.stubGlobal(
      "WebSocket",
      class {
        static OPEN = 1;
        readyState = 0;
        addEventListener(): void {}
        send(): void {}
        close(): void {}
      }
    );
    const w = await mountPane();
    expect(w.text()).toContain("使用中です"); // まだ隠れているので残っている
    await w.setProps({ active: true });
    await flushPromises();
    expect(useOpenConfigured().error.value).toBe("");
    expect(w.text()).not.toContain("使用中です");
    w.unmount();
  });
});
