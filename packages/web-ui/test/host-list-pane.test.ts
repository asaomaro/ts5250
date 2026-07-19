import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import HostListPane from "../src/components/HostListPane.vue";
import { systemsStore } from "../src/stores/systems.js";

/**
 * 一覧ペイン。管理画面と同じ「特殊なタブ ID」方式で開く。
 * 実際の取得は実機に依存するため、ここでは**表示の切り替えと操作の確認**を固定する。
 *
 * 取得元は**上段で選んだシステムをそのまま使う**——このペインで接続元を選び直させない。
 */
const originalFetch = globalThis.fetch;

const SYSTEM = { ref: "own:s1", name: "自分のシステム", host: "h", autoSignon: false };

/** システムを選んだ状態にする */
function selectSystem(): void {
  systemsStore.systems = [SYSTEM];
  systemsStore.sessions = [];
  systemsStore.loaded = true;
  systemsStore.select(SYSTEM.ref);
}

function mockFetch(handlers: Record<string, unknown>): void {
  globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const key = String(url);
    const body = handlers[key] ?? handlers[`${init?.method ?? "GET"} ${key}`] ?? {};
    return {
      ok: !(body as { __status?: number }).__status,
      json: async () => body
    } as Response;
  }) as typeof fetch;
}

beforeEach(() => {
  mockFetch({
    "/api/systems": { systems: [SYSTEM], editable: false },
    "/api/sessions-config": { sessions: [] }
  });
  selectSystem();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  systemsStore.systems = [];
  systemsStore.sessions = [];
  systemsStore.select(undefined);
  vi.restoreAllMocks();
});

describe("タブ ID で表示が切り替わる", () => {
  it.each([
    ["list:jobs", "ジョブ"],
    ["list:objects", "オブジェクト"],
    ["list:users", "ユーザー"]
  ])("%s は %s を表示する", async (tabId, title) => {
    const w = mount(HostListPane, { props: { tabId } });
    await flushPromises();
    expect(w.text()).toContain(title);
    w.unmount();
  });
});

describe("取得元は選択中システム", () => {
  it("接続元をここで選び直させない（システムはパンくずが示す）", async () => {
    const w = mount(HostListPane, { props: { tabId: "list:jobs" } });
    await flushPromises();
    // 接続元を選ぶ select は無い（絞り込みの select はある）
    const options = w.findAll("select option").map((o) => o.text());
    expect(options).not.toContain("自分のシステム");
    // システム名の重複表示もしない（ヘッダーのパンくすに出ているため）
    expect(w.text()).not.toContain("自分のシステム");
    w.unmount();
  });

  it("取得はシステム参照をそのまま送る", async () => {
    mockFetch({
      "/api/systems": { systems: [SYSTEM], editable: false },
      "/api/sessions-config": { sessions: [] },
      "/api/host/list/jobs": { items: [] }
    });
    const w = mount(HostListPane, { props: { tabId: "list:jobs" } });
    await flushPromises();
    await w.find("header button").trigger("click");
    await flushPromises();
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => String(c[0]) === "/api/host/list/jobs"
    );
    expect(JSON.parse(String((call?.[1] as RequestInit).body)).source).toEqual({ system: "own:s1" });
    w.unmount();
  });

  it("システム未選択でも壊れない", async () => {
    systemsStore.select(undefined);
    const w = mount(HostListPane, { props: { tabId: "list:jobs" } });
    await flushPromises();
    expect(w.text()).toContain("ジョブ");
    w.unmount();
  });
});

describe("絞り込みの項目が種類ごとに変わる", () => {
  it("ジョブはユーザーと種別", async () => {
    const w = mount(HostListPane, { props: { tabId: "list:jobs" } });
    await flushPromises();
    expect(w.text()).toContain("ユーザー");
    expect(w.text()).toContain("種別");
    w.unmount();
  });

  it("オブジェクトはライブラリと種別", async () => {
    const w = mount(HostListPane, { props: { tabId: "list:objects" } });
    await flushPromises();
    expect(w.text()).toContain("ライブラリ");
    w.unmount();
  });
});

describe("取得の失敗を表示する", () => {
  it("サーバーのエラーメッセージをそのまま出す", async () => {
    mockFetch({
      "/api/systems": { systems: [SYSTEM], editable: false },
      "/api/sessions-config": { sessions: [] },
      "/api/host/list/jobs": { __status: 502, error: "ユーザーとパスワードが登録されていません" }
    });
    const w = mount(HostListPane, { props: { tabId: "list:jobs" } });
    await flushPromises();
    await w.find("header button").trigger("click");
    await flushPromises();
    expect(w.text()).toContain("ユーザーとパスワード");
    w.unmount();
  });

  it("システムを選ばずに取得したら促す", async () => {
    mockFetch({ "/api/systems": { systems: [], editable: false }, "/api/sessions-config": { sessions: [] } });
    systemsStore.systems = [];
    systemsStore.select(undefined);
    const w = mount(HostListPane, { props: { tabId: "list:jobs" } });
    await flushPromises();
    await w.find("header button").trigger("click");
    await flushPromises();
    expect(w.text()).toContain("システムを選んでください");
    w.unmount();
  });
});

describe("破壊的な操作は確認を挟む", () => {
  it("確認を拒否したら実行しない", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    mockFetch({
      "/api/systems": { systems: [SYSTEM], editable: false },
      "/api/sessions-config": { sessions: [] },
      "/api/host/list/objects": {
        items: [{ name: "A1", library: "MYLIB", type: "*FILE" }]
      }
    });
    const w = mount(HostListPane, { props: { tabId: "list:objects" } });
    await flushPromises();
    await w.find("header button").trigger("click");
    await flushPromises();

    const before = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    await w.find("td.actions button").trigger("click");
    await flushPromises();
    // 確認を断ったので新たな通信は発生しない
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(before);
    expect(confirmSpy).toHaveBeenCalled();
    w.unmount();
  });
});
