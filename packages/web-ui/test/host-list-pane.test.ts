import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import HostListPane from "../src/components/HostListPane.vue";

/**
 * 一覧ペイン。管理画面と同じ「特殊なタブ ID」方式で開く。
 * 実際の取得は実機に依存するため、ここでは**表示の切り替えと操作の確認**を固定する。
 */
const originalFetch = globalThis.fetch;

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
    "/api/connections": { connections: [{ id: "c1", name: "自分の接続" }] },
    "/api/profiles": { profiles: [{ name: "pub400" }] }
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("タブ ID で表示が切り替わる", () => {
  it.each([
    ["list:jobs", "ジョブ一覧"],
    ["list:objects", "オブジェクト一覧"],
    ["list:users", "ユーザー一覧"]
  ])("%s は %s を表示する", async (tabId, title) => {
    const w = mount(HostListPane, { props: { tabId } });
    await flushPromises();
    expect(w.text()).toContain(title);
    w.unmount();
  });
});

describe("接続の選択", () => {
  it("自分の接続とサーバー設定の両方を候補にする", async () => {
    const w = mount(HostListPane, { props: { tabId: "list:jobs" } });
    await flushPromises();
    const options = w.findAll("select option").map((o) => o.text());
    expect(options.some((t) => t.includes("自分の接続"))).toBe(true);
    expect(options.some((t) => t.includes("pub400"))).toBe(true);
    w.unmount();
  });

  it("サーバー設定が見えない利用者でも壊れない", async () => {
    mockFetch({ "/api/connections": { connections: [{ id: "c1", name: "只の接続" }] } });
    const w = mount(HostListPane, { props: { tabId: "list:jobs" } });
    await flushPromises();
    expect(w.text()).toContain("ジョブ一覧");
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
      "/api/connections": { connections: [{ id: "c1", name: "接続" }] },
      "/api/profiles": { profiles: [] },
      "/api/host/list/jobs": { __status: 502, error: "ユーザーとパスワードが登録されていません" }
    });
    const w = mount(HostListPane, { props: { tabId: "list:jobs" } });
    await flushPromises();
    await w.find("header button").trigger("click");
    await flushPromises();
    expect(w.text()).toContain("ユーザーとパスワード");
    w.unmount();
  });

  it("接続を選ばずに取得したら促す", async () => {
    mockFetch({ "/api/connections": { connections: [] }, "/api/profiles": { profiles: [] } });
    const w = mount(HostListPane, { props: { tabId: "list:jobs" } });
    await flushPromises();
    await w.find("header button").trigger("click");
    await flushPromises();
    expect(w.text()).toContain("接続設定を選んで");
    w.unmount();
  });
});

describe("破壊的な操作は確認を挟む", () => {
  it("確認を拒否したら実行しない", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    mockFetch({
      "/api/connections": { connections: [{ id: "c1", name: "接続" }] },
      "/api/profiles": { profiles: [] },
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
