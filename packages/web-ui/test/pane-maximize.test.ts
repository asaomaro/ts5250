import { describe, it, expect, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import PaneTabs from "../src/components/PaneTabs.vue";
import { workspaceStore } from "../src/stores/workspace.js";

/** s1/s2 の 2 ペインに分割した状態を作り、[左グループ, 右グループ] を返す */
function splitTwo() {
  workspaceStore.init();
  workspaceStore.addSession("s1");
  workspaceStore.addSession("s2");
  const g = workspaceStore.focusedGroup();
  workspaceStore.split(g.id, "right", "s2");
  return workspaceStore.groups();
}

describe("workspaceStore ペイン最大化", () => {
  beforeEach(() => workspaceStore.init());

  it("分割していなければ最大化しない（押しても意味が無い）", () => {
    workspaceStore.addSession("s1");
    workspaceStore.toggleMaximize(workspaceStore.focusedGroup().id);
    expect(workspaceStore.maximizedGroupId).toBeUndefined();
    expect(workspaceStore.isSplit()).toBe(false);
  });

  it("最大化すると displayRoot がそのグループだけになり、ツリーは保持される", () => {
    const [left, right] = splitTwo();
    const rootBefore = workspaceStore.root;
    workspaceStore.toggleMaximize(right!.id);
    expect(workspaceStore.displayRoot()).toBe(right);
    expect(workspaceStore.focusedGroupId).toBe(right!.id);
    // ツリー自体は書き換えない（元に戻せる）
    expect(workspaceStore.root).toBe(rootBefore);
    expect(workspaceStore.groups()).toEqual([left, right]);
  });

  it("もう一度押すと元に戻る", () => {
    const [, right] = splitTwo();
    workspaceStore.toggleMaximize(right!.id);
    workspaceStore.toggleMaximize(right!.id);
    expect(workspaceStore.maximizedGroupId).toBeUndefined();
    expect(workspaceStore.displayRoot()).toBe(workspaceStore.root);
  });

  it("最大化中の split は分割せず合流（タブ移動）になる", () => {
    const [left, right] = splitTwo();
    left!.tabs.push("s3"); // 左に 2 枚 → 合流しても分割は残る
    workspaceStore.toggleMaximize(right!.id);
    workspaceStore.split(right!.id, "bottom", "s3");
    // 入れ子の分割は増えず（2 グループのまま）、タブが合流しただけ
    expect(workspaceStore.groups()).toHaveLength(2);
    expect(right!.tabs).toEqual(["s2", "s3"]);
    expect(left!.tabs).toEqual(["s1"]);
    expect(workspaceStore.maximizedGroupId).toBe(right!.id);
  });

  it("最大化中のペインに複数タブがあれば、そのタブ間の移動はできる", () => {
    const [, right] = splitTwo();
    workspaceStore.dropTabInto(right!.id, "s1", 0); // s1 を右へ合流（分割は解ける）
    const only = workspaceStore.groups()[0]!;
    expect(only.tabs).toEqual(["s1", "s2"]);
    workspaceStore.setActiveTab(only.id, "s2");
    expect(only.activeTab).toBe("s2");
    workspaceStore.cycleTab(1);
    expect(only.activeTab).toBe("s1");
  });

  it("最大化中のグループが消えたら最大化を解除する", () => {
    const [, right] = splitTwo();
    workspaceStore.toggleMaximize(right!.id);
    workspaceStore.closeSession("s2");
    expect(workspaceStore.maximizedGroupId).toBeUndefined();
  });
});

describe("PaneTabs 最大化ボタン", () => {
  it("分割していないときはボタンを出さない", () => {
    workspaceStore.init();
    workspaceStore.addSession("s1");
    const w = mount(PaneTabs, { props: { group: workspaceStore.focusedGroup() } });
    expect(w.find(".maximize").exists()).toBe(false);
  });

  it("分割中はボタンが出て、押すと最大化 / もう一度押すと元に戻る", async () => {
    const [, right] = splitTwo();
    const w = mount(PaneTabs, { props: { group: right! } });
    const btn = w.find(".maximize");
    expect(btn.exists()).toBe(true);
    expect(btn.attributes("title")).toBe("ペインを最大化");

    await btn.trigger("click");
    expect(workspaceStore.maximizedGroupId).toBe(right!.id);
    expect(w.find(".maximize").attributes("title")).toBe("ペインを元に戻す");
    expect(w.find(".maximize").attributes("aria-pressed")).toBe("true");

    await w.find(".maximize").trigger("click");
    expect(workspaceStore.maximizedGroupId).toBeUndefined();
  });
});
