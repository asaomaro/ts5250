import { describe, it, expect, beforeEach } from "vitest";
import { workspaceStore } from "../src/stores/workspace.js";

/**
 * システム切り替えでタブを「隠す」ときの不変条件。
 *
 * 一番の眼目は **「隠す」が「閉じる」に化けないこと**。`visibleTabs` は描画側の派生であって、
 * `GroupNode.tabs` を書き換えない——書き換える実装にすると、復元漏れとタブを閉じたことが
 * 区別できなくなり、利用者から見ればセッションが消えたのと同じになる。
 */
describe("タブの可視フィルタ（システム所属）", () => {
  beforeEach(() => {
    workspaceStore.init();
    workspaceStore.tabSystem = {};
    workspaceStore.lastActiveBySystem = {};
  });

  it("visibleTabs は tabs 配列を書き換えない（隠すは閉じるではない）", () => {
    workspaceStore.addSession("a1", "srv:A");
    workspaceStore.addSession("b1", "own:B");
    const g = workspaceStore.focusedGroup();
    const before = [...g.tabs];

    workspaceStore.visibleTabs(g, "srv:A");
    workspaceStore.visibleTabs(g, "own:B");
    workspaceStore.visibleTabs(g, "srv:存在しない");
    workspaceStore.visibleTabs(g, undefined);

    expect(g.tabs).toEqual(before);
    // 返る配列を触っても実体に響かない
    const visible = workspaceStore.visibleTabs(g, "srv:A");
    visible.pop();
    expect(workspaceStore.focusedGroup().tabs).toEqual(before);
  });

  it("システムを切り替えるとタブが隠れ、戻すと再び現れる", () => {
    workspaceStore.addSession("a1", "srv:A");
    workspaceStore.addSession("a2", "srv:A");
    workspaceStore.addSession("b1", "own:B");
    const g = workspaceStore.focusedGroup();

    expect(workspaceStore.visibleTabs(g, "srv:A")).toEqual(["a1", "a2"]);
    // B へ切り替え → A のタブは見えない
    expect(workspaceStore.visibleTabs(g, "own:B")).toEqual(["b1"]);
    // A へ戻す → 消えずに戻ってくる
    expect(workspaceStore.visibleTabs(g, "srv:A")).toEqual(["a1", "a2"]);
    // 実体は最初から一度も減っていない
    expect(g.tabs).toEqual(["a1", "a2", "b1"]);
  });

  it("所属が記録されていないタブは常に見える（記録漏れで消えるより余計に見えるほうが安全）", () => {
    workspaceStore.addSession("orphan"); // systemRef を渡さない＝対応表に載らない
    workspaceStore.addSession("a1", "srv:A");
    const g = workspaceStore.focusedGroup();

    expect(workspaceStore.visibleTabs(g, "srv:A")).toEqual(["orphan", "a1"]);
    expect(workspaceStore.visibleTabs(g, "own:B")).toEqual(["orphan"]);
    expect(workspaceStore.visibleTabs(g, undefined)).toEqual(["orphan", "a1"]);
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

  it("closeSession は最後に見ていたタブの記録も片付ける", () => {
    workspaceStore.addSession("a1", "srv:A");
    expect(workspaceStore.lastActiveBySystem["srv:A"]).toBe("a1");
    workspaceStore.closeSession("a1");
    expect(workspaceStore.lastActiveBySystem["srv:A"]).toBeUndefined();
  });

  it("activeTabFor は切り替えて戻ったとき最後に見ていたタブへ復帰する", () => {
    workspaceStore.addSession("a1", "srv:A");
    workspaceStore.addSession("a2", "srv:A"); // A の最後は a2
    workspaceStore.addSession("b1", "own:B"); // いま activeTab = b1
    const g = workspaceStore.focusedGroup();

    // B では b1 が見える
    expect(workspaceStore.activeTabFor(g, "own:B")).toBe("b1");
    // A へ切り替え: activeTab(b1) は見えないので、最後に見ていた a2 へ戻す
    expect(workspaceStore.activeTabFor(g, "srv:A")).toBe("a2");
  });

  it("見えるタブが無ければ activeTabFor は undefined（ランチャーが出る）", () => {
    workspaceStore.addSession("a1", "srv:A");
    const g = workspaceStore.focusedGroup();
    expect(workspaceStore.activeTabFor(g, "own:B")).toBeUndefined();
  });

  it("assignSystem で後から所属を記録でき、可視判定に反映される", () => {
    workspaceStore.addSession("s1");
    const g = workspaceStore.focusedGroup();
    expect(workspaceStore.visibleTabs(g, "srv:A")).toEqual(["s1"]);

    workspaceStore.assignSystem("s1", "srv:A");
    expect(workspaceStore.visibleTabs(g, "srv:A")).toEqual(["s1"]);
    expect(workspaceStore.visibleTabs(g, "own:B")).toEqual([]);
  });
});

describe("一覧ペイン: システムを切り替えたら表示中の行を捨てる", () => {
  /**
   * 捨てないと、ヘッダーは新しいシステム名を出しているのに、並んでいるのは前のシステムの
   * ジョブ、という状態になる。**誤って別システムのジョブを終了しかねない。**
   */
  it("systemsStore.selected の変更で rows が空になる", async () => {
    const { mount, flushPromises } = await import("@vue/test-utils");
    const HostListPane = (await import("../src/components/HostListPane.vue")).default;
    const { systemsStore } = await import("../src/stores/systems.js");

    systemsStore.systems = [
      { ref: "own:s1", name: "A", host: "a", autoSignon: false },
      { ref: "own:s2", name: "B", host: "b", autoSignon: false }
    ];
    systemsStore.sessions = [];
    systemsStore.selected = "own:s1";

    globalThis.fetch = (async (url: string) =>
      url.startsWith("/api/host/list")
        ? { ok: true, json: async () => ({ items: [{ name: "J1", user: "U", number: "1", status: "*ACTIVE", type: "B", subtype: "" }] }) }
        : { ok: true, json: async () => ({ systems: systemsStore.systems, sessions: [], editable: false }) }) as never;

    const w = mount(HostListPane, { props: { tabId: "list:jobs" } });
    await flushPromises();
    await w.findAll("button").find((b) => b.text().includes("取得"))!.trigger("click");
    await flushPromises();
    expect(w.text()).toContain("J1");

    systemsStore.selected = "own:s2";
    await flushPromises();
    expect(w.text()).not.toContain("J1");
    w.unmount();
  });
});
