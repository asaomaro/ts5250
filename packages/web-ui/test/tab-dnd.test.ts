import { describe, it, expect, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import PaneTabs from "../src/components/PaneTabs.vue";
import { workspaceStore } from "../src/stores/workspace.js";
import { systemsStore } from "../src/stores/systems.js";

/**
 * タブの D&D 目印。
 *
 * 「タブ耳の上を通ってから帯の空き領域へ移ると、ドロップ領域が出ない」不具合の回帰防止。
 * 原因は、タブ耳で立った `reorder` が残っている間だけ帯の目印を抑制していたこと。
 */
function setup(): ReturnType<typeof mount> {
  workspaceStore.init();
  workspaceStore.tabSystem = {};
  systemsStore.selected = undefined;
  const g = workspaceStore.groups()[0]!;
  g.tabs = ["a", "b"];
  g.activeTab = "a";
  return mount(PaneTabs, { props: { group: g } });
}

describe("タブの D&D: ドロップ領域の目印", () => {
  beforeEach(() => {
    workspaceStore.draggingSession = undefined;
  });

  it("別グループから: タブ耳を通ってから帯へ移っても、合流の目印が出る", async () => {
    const w = setup();
    // 別グループのタブを掴んでいる想定（合流するので帯の目印に意味がある）
    workspaceStore.draggingSession = "z";

    // 1. タブ耳の上（挿入位置の目印が立つ）
    const tab = w.findAll(".tab")[1]!;
    await tab.trigger("dragover", { clientX: 10 });
    expect(w.findAll(".drop-before, .drop-after").length).toBeGreaterThan(0);

    // 2. 帯の空き領域へ移動（ここが以前は無反応だった）
    await w.find(".tabs").trigger("dragover");
    expect(w.find(".tabs").classes()).toContain("strip-drop");
    // 過去の挿入目印は消えている（二重に出さない）
    expect(w.findAll(".drop-before, .drop-after").length).toBe(0);
    w.unmount();
  });

  it("帯から完全に出たら目印を消す", async () => {
    const w = setup();
    workspaceStore.draggingSession = "z";
    await w.find(".tabs").trigger("dragover");
    expect(w.find(".tabs").classes()).toContain("strip-drop");

    await w.find(".tabs").trigger("dragleave", { relatedTarget: document.body });
    expect(w.find(".tabs").classes()).not.toContain("strip-drop");
    w.unmount();
  });

  it("同じグループ内の並べ替えでは合流の目印を出さない", async () => {
    // 移動先が変わらないので、合流の目印には意味がない
    const w = setup();
    workspaceStore.draggingSession = "a";
    await w.find(".tabs").trigger("dragover");
    expect(w.find(".tabs").classes()).not.toContain("strip-drop");
    w.unmount();
  });

  it("ドラッグしていなければ目印は出ない", async () => {
    const w = setup();
    await w.find(".tabs").trigger("dragover");
    expect(w.find(".tabs").classes()).not.toContain("strip-drop");
    w.unmount();
  });
});
