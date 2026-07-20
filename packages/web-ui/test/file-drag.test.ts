import { describe, it, expect, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import WorkspaceNode from "../src/components/WorkspaceNode.vue";
import PaneTabs from "../src/components/PaneTabs.vue";
import { workspaceStore } from "../src/stores/workspace.js";
import { isFileDrag } from "../src/dnd.js";

/**
 * ファイルの D&D と、既存の D&D（ペイン分割・タブ移動）の棲み分け。
 *
 * データ転送ペインが CSV をドロップで受けるようになったため、
 * **ファイルを落としたときにペインが割れたりタブが動いたりしてはいけない**。
 * 判定は `dnd.ts` の 1 か所（タブは `text/session`、ファイルは `Files`）。
 */
const filesDt = { types: ["Files"], getData: () => "", files: [] };
const tabDt = { types: ["text/session"], getData: () => "s2", files: [] };

describe("isFileDrag", () => {
  it("Files を含むドラッグだけを真とする", () => {
    expect(isFileDrag({ dataTransfer: filesDt } as unknown as DragEvent)).toBe(true);
    expect(isFileDrag({ dataTransfer: tabDt } as unknown as DragEvent)).toBe(false);
    expect(isFileDrag({ dataTransfer: null } as unknown as DragEvent)).toBe(false);
  });
});

describe("ペイン分割はファイルのドラッグを無視する", () => {
  beforeEach(() => {
    workspaceStore.init();
    workspaceStore.addSession("s1");
    workspaceStore.addSession("s2");
    workspaceStore.draggingSession = undefined;
  });

  it("**ファイルを端に落としても分割しない**", async () => {
    const w = mount(WorkspaceNode, { props: { node: workspaceStore.root } });
    const group = w.find(".group");
    await group.trigger("dragover", { dataTransfer: filesDt, clientX: 0, clientY: 50 });
    expect(w.find(".dz").exists()).toBe(false); // ドロップゾーンの目印すら出さない
    await group.trigger("drop", { dataTransfer: filesDt, clientX: 0, clientY: 50 });
    expect(workspaceStore.groups()).toHaveLength(1); // 割れていない
    w.unmount();
  });

  it("タブのドラッグは従来どおり分割の目印を出す（無効化しすぎない）", async () => {
    workspaceStore.draggingSession = "s2";
    const w = mount(WorkspaceNode, { props: { node: workspaceStore.root } });
    await w.find(".group").trigger("dragover", { dataTransfer: tabDt, clientX: 0, clientY: 50 });
    expect(w.find(".dz").exists()).toBe(true);
    w.unmount();
  });
});

describe("タブ移動はファイルのドラッグを無視する", () => {
  beforeEach(() => {
    workspaceStore.init();
    workspaceStore.addSession("s1");
    workspaceStore.addSession("s2");
    workspaceStore.addSession("s3");
    workspaceStore.draggingSession = undefined;
  });

  it("**ファイルをタブ帯に落としても並びが変わらない**", async () => {
    const w = mount(PaneTabs, { props: { group: workspaceStore.focusedGroup() } });
    const before = [...workspaceStore.focusedGroup().tabs];
    workspaceStore.draggingSession = "s3"; // タブもドラッグ中だとしても、ファイルが優先で無視される
    await w.find(".tabs").trigger("dragover", { dataTransfer: filesDt });
    expect(w.find(".tabs").classes()).not.toContain("strip-drop"); // 合流の目印を出さない
    await w.find(".tabs").trigger("drop", { dataTransfer: filesDt });
    expect(workspaceStore.focusedGroup().tabs).toEqual(before);
    w.unmount();
  });

  it("ファイルをタブ耳に落としても並び替えない", async () => {
    const w = mount(PaneTabs, { props: { group: workspaceStore.focusedGroup() } });
    const before = [...workspaceStore.focusedGroup().tabs];
    workspaceStore.draggingSession = "s3";
    const tabs = w.findAll(".tab");
    await tabs[0]!.trigger("dragover", { dataTransfer: filesDt, clientX: 10 });
    await tabs[0]!.trigger("drop", { dataTransfer: filesDt, clientX: 10 });
    expect(workspaceStore.focusedGroup().tabs).toEqual(before);
    w.unmount();
  });
});
