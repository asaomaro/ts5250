import { describe, it, expect, beforeEach } from "vitest";
import { workspaceStore } from "../src/stores/workspace.js";
import { makePaneTabId } from "../src/paneLabels.js";

/**
 * **タブは隠れない**（`20260802-tabs-own-system`）。
 *
 * 以前はシステムを切り替えると、そのシステムのタブだけを出していた。
 * **異なるシステムのタブを並べて同時に見たい**という要望に対し、それは真っ向から
 * 邪魔になるので絞り込みをやめた。見分けはタブの色帯とシステム名が担う。
 *
 * 旧仕様で守っていた「**隠すが閉じるに化けない**」という不変条件は、
 * 隠さなくなった以上もっと単純になった——`visibleTabs` は `tabs` 配列を触らない、で足りる。
 */
describe("タブは絞り込まれない", () => {
  beforeEach(() => {
    workspaceStore.init();
    workspaceStore.tabSystem = {};
  });

  it("**システムに関わらず全部見える**（並べて見るための前提）", () => {
    workspaceStore.addSession("a1", "srv:A");
    workspaceStore.addSession("b1", "own:B");
    const g = workspaceStore.focusedGroup();
    expect(workspaceStore.visibleTabs(g)).toEqual(["a1", "b1"]);
  });

  it("`visibleTabs` は tabs 配列を書き換えない（返り値を触っても実体に響かない）", () => {
    workspaceStore.addSession("a1", "srv:A");
    workspaceStore.addSession("b1", "own:B");
    const g = workspaceStore.focusedGroup();
    const before = [...g.tabs];

    const visible = workspaceStore.visibleTabs(g);
    visible.pop();

    expect(workspaceStore.focusedGroup().tabs).toEqual(before);
  });

  it("closeSession で tabSystem からも外れる（閉じたタブの所属を残さない）", () => {
    workspaceStore.addSession("a1", "srv:A");
    workspaceStore.addSession("a2", "srv:A");
    expect(workspaceStore.tabSystem["a1"]).toBe("srv:A");

    workspaceStore.closeSession("a1");
    expect(workspaceStore.tabSystem["a1"]).toBeUndefined();
    expect(workspaceStore.tabSystem["a2"]).toBe("srv:A");
    expect(workspaceStore.focusedGroup().tabs).toEqual(["a2"]);
  });
});

/**
 * **そのタブのシステムをどこから引くか**（`20260802-tabs-own-system`）。
 * アプリ系はタブ ID そのものが持ち、セッション系は対応表から引く。
 * 引き方を 1 か所に閉じるのが眼目——散らすと「画面と宛先の食い違い」が生まれる。
 */
describe("systemOf", () => {
  beforeEach(() => {
    workspaceStore.init();
    workspaceStore.tabSystem = {};
  });

  it("アプリ系タブは ID から引く（対応表に無くても分かる）", () => {
    const tab = makePaneTabId("sql:query", "own:a");
    expect(workspaceStore.systemOf(tab)).toBe("own:a");
    expect(workspaceStore.tabSystem[tab], "対応表には載っていない").toBeUndefined();
  });

  it("システムに紐づかないアプリ画面は undefined（サービス一覧・管理）", () => {
    expect(workspaceStore.systemOf("svc:services")).toBeUndefined();
    expect(workspaceStore.systemOf("admin:logs")).toBeUndefined();
  });

  it("セッション系タブは対応表から引く（ID は変えていない）", () => {
    workspaceStore.addSession("sess-1", "own:b");
    expect(workspaceStore.systemOf("sess-1")).toBe("own:b");
  });
});

/**
 * **アプリ全体の選択に引きずられない**（`20260802-tabs-own-system`）。
 * 以前は「切り替えたら行を捨てる」だった。いまはタブが自分のシステムを持つので、
 * 全体の選択が動いても表示も宛先も動かない。
 */
describe("一覧ペイン: 全体の選択に引きずられない", () => {
  it("systemsStore.menuSystem を変えても行はそのまま", async () => {
    const { mount, flushPromises } = await import("@vue/test-utils");
    const HostListPane = (await import("../src/components/HostListPane.vue")).default;
    const { systemsStore } = await import("../src/stores/systems.js");

    systemsStore.systems = [
      { ref: "own:s1", name: "A", host: "a", autoSignon: false },
      { ref: "own:s2", name: "B", host: "b", autoSignon: false }
    ];
    systemsStore.sessions = [];
    systemsStore.menuSystem = "own:s1";

    globalThis.fetch = (async (url: string) =>
      url.startsWith("/api/host/list")
        ? { ok: true, json: async () => ({ items: [{ name: "J1", user: "U", number: "1", status: "*ACTIVE", type: "B", subtype: "" }] }) }
        : { ok: true, json: async () => ({ systems: systemsStore.systems, sessions: [], editable: false }) }) as never;

    const w = mount(HostListPane, { props: { tabId: "list:jobs", system: "own:s1" } });
    await flushPromises();
    await w.findAll("button").find((b) => b.text().includes("取得"))!.trigger("click");
    await flushPromises();
    expect(w.text()).toContain("J1");

    systemsStore.menuSystem = "own:s2";
    await flushPromises();
    expect(w.text(), "全体の選択に引きずられて捨てている").toContain("J1");
    w.unmount();
  });
});
