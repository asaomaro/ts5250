import { describe, it, expect, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import PaneTabs from "../src/components/PaneTabs.vue";
import { workspaceStore } from "../src/stores/workspace.js";

describe("PaneTabs タブ並び替え D&D", () => {
  beforeEach(() => {
    workspaceStore.init();
    workspaceStore.addSession("s1");
    workspaceStore.addSession("s2");
    workspaceStore.addSession("s3"); // [s1, s2, s3]
    workspaceStore.draggingSession = undefined;
  });

  function mountTabs() {
    return mount(PaneTabs, { props: { group: workspaceStore.focusedGroup() } });
  }

  it("タブをドラッグして別タブの後ろにドロップすると並びが入れ替わる", async () => {
    const w = mountTabs();
    const tabs = w.findAll(".tab");
    expect(tabs).toHaveLength(3);
    // s1 をドラッグ開始 → s3 の後ろ（clientX>中点=0）へドロップ
    await tabs[0]!.trigger("dragstart");
    expect(workspaceStore.draggingSession).toBe("s1");
    await tabs[2]!.trigger("dragover", { clientX: 10 });
    await tabs[2]!.trigger("drop", { clientX: 10 });
    expect(workspaceStore.focusedGroup().tabs).toEqual(["s2", "s3", "s1"]);
    expect(workspaceStore.draggingSession).toBeUndefined(); // ドロップで解除
  });

  it("別タブの前へドロップ（中点より左）だと手前に挿入される", async () => {
    const w = mountTabs();
    const tabs = w.findAll(".tab");
    // s3 をドラッグ → s1 の前（clientX=0 は中点0より大きくない＝before）へ
    await tabs[2]!.trigger("dragstart");
    await tabs[0]!.trigger("dragover", { clientX: 0 });
    await tabs[0]!.trigger("drop", { clientX: 0 });
    expect(workspaceStore.focusedGroup().tabs).toEqual(["s3", "s1", "s2"]);
  });

  it("自分自身へのドロップは無操作", async () => {
    const w = mountTabs();
    const tabs = w.findAll(".tab");
    await tabs[1]!.trigger("dragstart");
    await tabs[1]!.trigger("dragover", { clientX: 10 });
    await tabs[1]!.trigger("drop", { clientX: 10 });
    expect(workspaceStore.focusedGroup().tabs).toEqual(["s1", "s2", "s3"]);
  });

  it("タブエリアの空き領域へドロップすると末尾へ追加される", async () => {
    const w = mountTabs();
    const tabs = w.findAll(".tab");
    await tabs[1]!.trigger("dragstart"); // s2
    await w.find(".tabs").trigger("dragover");
    await w.find(".tabs").trigger("drop");
    expect(workspaceStore.focusedGroup().tabs).toEqual(["s1", "s3", "s2"]);
  });
});

describe("PaneTabs 別ペインのタブをタブエリアへドロップして合流", () => {
  beforeEach(() => {
    workspaceStore.init();
    workspaceStore.addSession("a1");
    workspaceStore.addSession("a2");
    const g0 = workspaceStore.focusedGroup();
    workspaceStore.split(g0.id, "right", "a2"); // 左[a1] | 右[a2] の 2 ペイン
    workspaceStore.draggingSession = undefined;
  });

  it("別グループのタブをこのタブエリアへドロップすると合流し、空ペインは片付く", async () => {
    const [gA, gB] = workspaceStore.groups(); // gA=[a1], gB=[a2]
    const w = mount(PaneTabs, { props: { group: gA! } });
    // 右ペイン(gB)の a2 をドラッグ中として、左ペイン(gA)のタブエリアへドロップ
    workspaceStore.draggingSession = "a2";
    await w.find(".tabs").trigger("dragover");
    await w.find(".tabs").trigger("drop");
    expect(workspaceStore.groups()).toHaveLength(1); // gB 空 → 片付け
    expect(workspaceStore.groups()[0]!.tabs).toEqual(["a1", "a2"]);
    expect(workspaceStore.groups()[0]!.activeTab).toBe("a2");
    expect(workspaceStore.draggingSession).toBeUndefined();
  });
});
