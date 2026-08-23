import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MSG_SYSTEM_GONE } from "../src/composables/opMessages.js";
import { mount, flushPromises } from "@vue/test-utils";
import HostListPane from "../src/components/HostListPane.vue";
import { systemsStore } from "../src/stores/systems.js";
import { makePaneTabId } from "../src/paneLabels.js";

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
    const w = mount(HostListPane, { props: { tabId, system: SYSTEM.ref } });
    await flushPromises();
    expect(w.text()).toContain(title);
    w.unmount();
  });

  /**
   * **実際に開かれるタブ ID にはシステムが付く**（`list:jobs@own:s1`。`20260802-tabs-own-system`）。
   *
   * 上の `it.each` が**素の機能 ID**で書かれていたため、接頭辞を剥がすだけの実装
   * （`tabId.replace(/^list:/, "")`）が `jobs@own:s1` を返していることに気づけず、
   * 取得が **`unknown list kind: jobs@own:s-…`（404）** で落ちていた。
   * 以降はここを**実物の形**で固定する。
   */
  it.each([
    ["list:jobs", "jobs", "ジョブ"],
    ["list:objects", "objects", "オブジェクト"],
    ["list:users", "users", "ユーザー"]
  ])("システム付きの %s でも %s として取得する", async (feature, kind, title) => {
    mockFetch({
      "/api/systems": { systems: [SYSTEM], editable: false },
      "/api/sessions-config": { sessions: [] },
      [`/api/host/list/${kind}`]: { items: [] }
    });
    const tabId = makePaneTabId(feature, SYSTEM.ref); // list:jobs@own:s1
    const w = mount(HostListPane, { props: { tabId, system: SYSTEM.ref } });
    await flushPromises();
    expect(w.text()).toContain(title);

    await w.find("header button").trigger("click");
    await flushPromises();
    const urls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(urls).toContain(`/api/host/list/${kind}`);
    expect(urls.some((u) => u.includes("@"))).toBe(false); // システムを URL へ漏らさない
    w.unmount();
  });
});

describe("取得元は選択中システム", () => {
  it("接続元をここで選び直させない（システムはパンくずが示す）", async () => {
    const w = mount(HostListPane, { props: { tabId: "list:jobs", system: SYSTEM.ref } });
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
    const w = mount(HostListPane, { props: { tabId: "list:jobs", system: SYSTEM.ref } });
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
    const w = mount(HostListPane, { props: { tabId: "list:jobs", system: SYSTEM.ref } });
    await flushPromises();
    expect(w.text()).toContain("ジョブ");
    w.unmount();
  });
});

describe("絞り込みの項目が種類ごとに変わる", () => {
  it("ジョブはユーザーと種別", async () => {
    const w = mount(HostListPane, { props: { tabId: "list:jobs", system: SYSTEM.ref } });
    await flushPromises();
    expect(w.text()).toContain("ユーザー");
    expect(w.text()).toContain("種別");
    w.unmount();
  });

  it("オブジェクトはライブラリと種別", async () => {
    const w = mount(HostListPane, { props: { tabId: "list:objects", system: SYSTEM.ref } });
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
    const w = mount(HostListPane, { props: { tabId: "list:jobs", system: SYSTEM.ref } });
    await flushPromises();
    await w.find("header button").trigger("click");
    await flushPromises();
    expect(w.text()).toContain("ユーザーとパスワード");
    w.unmount();
  });

  /**
   * **このタブのシステムが設定から消えたとき**（`20260802-tabs-own-system`）。
   * 以前は「システム未選択」だったが、タブは 1 つのシステムへの窓になったので、
   * `system` が空なのは消えたときだけ——利用者に選び直す手立ては無い。
   */
  it("システムが消えていたら取得せず理由を出す", async () => {
    mockFetch({ "/api/systems": { systems: [], editable: false }, "/api/sessions-config": { sessions: [] } });
    const w = mount(HostListPane, { props: { tabId: "list:jobs" } });
    await flushPromises();
    await w.find("header button").trigger("click");
    await flushPromises();
    expect(w.text()).toContain(MSG_SYSTEM_GONE);
    expect(globalThis.fetch as ReturnType<typeof vi.fn>).not.toHaveBeenCalledWith(
      expect.stringContaining("/api/host/"),
      expect.anything()
    );
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
        items: [{ name: "A1", library: "TESTLIB", type: "*FILE" }]
      }
    });
    const w = mount(HostListPane, { props: { tabId: "list:objects", system: SYSTEM.ref } });
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

describe("列見出しの固定", () => {
  /**
   * 見出し（絞り込みの帯）と列見出しはスクロールで流れてはいけない。
   * **スクロールは `.scroll` の中だけ**に閉じ込める構造を固定する
   * （表をペイン直下に戻すと、ペイン全体が流れて列見出しが消える）。
   */
  it("表はスクロール領域の中、絞り込みの帯は外に置く", async () => {
    mockFetch({
      "/api/systems": { systems: [SYSTEM], editable: false },
      "/api/sessions-config": { sessions: [] },
      "/api/host/list/jobs": {
        items: [{ number: "123456", user: "QUSER", name: "QZDASOINIT", status: "ACTIVE", type: "B", subtype: "" }]
      }
    });
    const w = mount(HostListPane, { props: { tabId: "list:jobs", system: SYSTEM.ref } });
    await flushPromises();
    await w.find("header button").trigger("click");
    await flushPromises();
    expect(w.find(".scroll table thead th").exists()).toBe(true);
    // 帯はスクロール領域の外（＝常に見える）
    expect(w.find(".scroll header").exists()).toBe(false);
    expect(w.find(".host-list > header").exists()).toBe(true);
    w.unmount();
  });
});
