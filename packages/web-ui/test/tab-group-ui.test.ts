import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { mount } from "@vue/test-utils";
import PaneTabs from "../src/components/PaneTabs.vue";
import { workspaceStore } from "../src/stores/workspace.js";

/**
 * **タブグループ**（`20260804-tab-groups`）の UI 側——チップ・重ねる D&D・ポップアップ。
 */

function mountTabs() {
  return mount(PaneTabs, { props: { group: workspaceStore.focusedGroup() } });
}

/** jsdom の矩形は全て 0 なので、中央ゾーンを試すには幅を持たせる必要がある */
function withRect(el: Element, left: number, width: number): void {
  (el as HTMLElement).getBoundingClientRect = () =>
    ({ left, width, right: left + width, top: 0, bottom: 24, height: 24, x: left, y: 0 }) as DOMRect;
}

describe("タブグループのチップ", () => {
  beforeEach(() => {
    workspaceStore.init();
    for (const t of ["s1", "s2", "s3"]) workspaceStore.addSession(t);
    workspaceStore.groupTabs(workspaceStore.focusedGroup().id, "s1", "s2");
  });

  it("グループの先頭タブの手前にチップが出る。名前が空なら色だけ", () => {
    const w = mountTabs();
    const chip = w.find(".tg-chip");
    expect(chip.exists()).toBe(true);
    expect(chip.find(".tg-name").exists()).toBe(false);
    // 並びは チップ → s1 → s2 → s3
    const kinds = w.findAll(".tg-chip, .tab").map((e) => (e.classes("tg-chip") ? "chip" : "tab"));
    expect(kinds).toEqual(["chip", "tab", "tab", "tab"]);
  });

  it("名前を付けるとチップに出る", async () => {
    const tgId = workspaceStore.tabGroupOfTab("s1")!.id;
    workspaceStore.renameTabGroup(tgId, "検証作業");
    const w = mountTabs();
    await w.vm.$nextTick();
    expect(w.find(".tg-chip .tg-name").text()).toBe("検証作業");
  });

  it("メンバーだけがグループ色の装飾を持つ（グループ外のタブは従来どおり）", () => {
    const w = mountTabs();
    const tabs = w.findAll(".tab");
    expect(tabs[0]!.classes()).toContain("tg-member");
    expect(tabs[0]!.classes()).toContain("tg-first");
    expect(tabs[1]!.classes()).toContain("tg-last");
    expect(tabs[2]!.classes()).not.toContain("tg-member");
    expect(tabs[0]!.attributes("style")).toContain("--tg:");
  });

  it("メンバーでもシステムカラー帯は残る（`--tab-sys` と `--tg` を同時に持つ）", () => {
    // 軸が違う 2 つの色——**どのシステムか**（左端 3px の帯）と**どの作業か**（面）。
    // 片方が他方を追い出していないことを確かめる（`20260802-tabs-own-system` の見分けを潰さない）
    workspaceStore.assignSystem("s1", "srv:A");
    const w = mountTabs();
    const style = w.findAll(".tab")[0]!.attributes("style")!;
    expect(style).toContain("--tab-sys:");
    expect(style).toContain("--tg:");
  });

  it("`∨` を押すと畳み、タブが消えてチップだけが残る（`›` に変わる）", async () => {
    const w = mountTabs();
    await w.find(".tg-fold").trigger("click");

    expect(w.findAll(".tab")).toHaveLength(1); // s3 のみ
    expect(w.find(".tg-chip").classes()).toContain("collapsed");
    expect(w.find(".tg-fold").text()).toBe("›");
  });

  it("畳んだ中のタブがアクティブなときはチップに印が出る（中身が出ている理由を示す）", async () => {
    const g = workspaceStore.focusedGroup();
    workspaceStore.setActiveTab(g.id, "s2");
    const w = mountTabs();
    await w.find(".tg-fold").trigger("click");

    expect(workspaceStore.focusedGroup().activeTab).toBe("s2"); // アクティブは動かない
    expect(w.find(".tg-chip").classes()).toContain("on");
  });
});

describe("重ねてグループ化する D&D", () => {
  beforeEach(() => {
    workspaceStore.init();
    for (const t of ["s1", "s2", "s3"]) workspaceStore.addSession(t);
    workspaceStore.draggingSession = undefined;
  });

  it("タブの中央へ落とすとグループになる", async () => {
    const w = mountTabs();
    const tabs = w.findAll(".tab");
    withRect(tabs[2]!.element, 0, 100);

    await tabs[0]!.trigger("dragstart"); // s1
    await tabs[2]!.trigger("dragover", { clientX: 50 }); // s3 の中央
    expect(tabs[2]!.classes()).toContain("drop-into"); // 予告が出る
    await tabs[2]!.trigger("drop", { clientX: 50 });

    const tg = workspaceStore.tabGroupOfTab("s1");
    expect(tg).toBeDefined();
    expect(workspaceStore.tabGroupTabs(tg!.id)).toEqual(["s3", "s1"]);
  });

  it("タブの端へ落とすと従来どおり並べ替え（グループにならない）", async () => {
    const w = mountTabs();
    const tabs = w.findAll(".tab");
    withRect(tabs[2]!.element, 0, 100);

    await tabs[0]!.trigger("dragstart");
    await tabs[2]!.trigger("dragover", { clientX: 95 }); // 右端
    expect(tabs[2]!.classes()).toContain("drop-after");
    await tabs[2]!.trigger("drop", { clientX: 95 });

    expect(Object.keys(workspaceStore.tabGroups)).toEqual([]);
    expect(workspaceStore.focusedGroup().tabs).toEqual(["s2", "s3", "s1"]);
  });

  it("畳んだチップへ落とすと参加する。**畳んだままにする**（勝手に開かない）", async () => {
    workspaceStore.groupTabs(workspaceStore.focusedGroup().id, "s1", "s2");
    const tgId = workspaceStore.tabGroupOfTab("s1")!.id;
    workspaceStore.toggleTabGroupCollapsed(tgId);
    const w = mountTabs();

    workspaceStore.draggingSession = "s3";
    await w.find(".tg-chip").trigger("dragover");
    expect(w.find(".tg-chip").classes()).toContain("chip-drop");
    await w.find(".tg-chip").trigger("drop");

    expect(workspaceStore.tabGroupTabs(tgId)).toEqual(["s1", "s2", "s3"]);
    expect(workspaceStore.tabGroups[tgId]!.collapsed).toBe(true);
    // **表示中のタブは変わらない**——隠れたタブをアクティブにすると「何も選んでいないのに
    // 中身が変わった」ように見える（`moveTabGroupInto` と同じ規則）。
    // グループ化した時点の s2 のまま（畳む前に選ばれた）で、落とした s3 へは移らない
    expect(workspaceStore.focusedGroup().activeTab).toBe("s2");
  });

  it("メニューはチップの中にあるが、ドラッグ対象からは外してある（名前欄の選択がドラッグに化けない）", async () => {
    workspaceStore.groupTabs(workspaceStore.focusedGroup().id, "s1", "s2");
    const w = mountTabs();
    await w.find(".tg-chip").trigger("click");

    expect(w.find(".menu").attributes("draggable")).toBe("false");
    expect(w.find(".backdrop").attributes("draggable")).toBe("false");
  });

  it("チップを掴むとグループごとのドラッグになる（タブの箱には入れない）", async () => {
    workspaceStore.groupTabs(workspaceStore.focusedGroup().id, "s1", "s2");
    const tgId = workspaceStore.tabGroupOfTab("s1")!.id;
    const w = mountTabs();

    await w.find(".tg-chip").trigger("dragstart");

    expect(workspaceStore.draggingTabGroup).toBe(tgId);
    expect(workspaceStore.draggingSession).toBeUndefined();
  });

  it("別ペインのタブ帯へグループを落とすと、グループのまま合流する", async () => {
    workspaceStore.groupTabs(workspaceStore.focusedGroup().id, "s1", "s2");
    const tgId = workspaceStore.tabGroupOfTab("s1")!.id;
    const g0 = workspaceStore.focusedGroup();
    workspaceStore.split(g0.id, "right", "s3"); // 左[s1,s2] | 右[s3]
    const right = workspaceStore.groups().find((g) => g.tabs.includes("s3"))!;
    const w = mount(PaneTabs, { props: { group: right } });

    workspaceStore.draggingTabGroup = tgId;
    await w.find(".tabs").trigger("dragover");
    await w.find(".tabs").trigger("drop");

    expect(workspaceStore.groups()).toHaveLength(1);
    expect(workspaceStore.groups()[0]!.tabs).toEqual(["s3", "s1", "s2"]);
    expect(workspaceStore.tabGroupTabs(tgId)).toEqual(["s1", "s2"]);
  });
});

describe("タブグループのポップアップ", () => {
  beforeEach(() => {
    workspaceStore.init();
    // セッションを持たないタブ（`isPaneTab`）にする——一括クローズが接続を要らずに検証できる
    for (const t of ["sql:query@own:a", "ifs:browse@own:a", "svc:list"]) workspaceStore.addSession(t);
    workspaceStore.groupTabs(workspaceStore.focusedGroup().id, "sql:query@own:a", "ifs:browse@own:a");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("チップを押すと開き、名前入力・色 8 個・メニュー 2 項目が出る", async () => {
    const w = mountTabs();
    await w.find(".tg-chip").trigger("click");

    expect(w.find(".menu").exists()).toBe(true);
    expect(w.find("input.name").exists()).toBe(true);
    expect(w.findAll(".swatch")).toHaveLength(8);
    expect(w.findAll(".item").map((b) => b.text())).toEqual([
      "⌧ グループ化を解除",
      "⊗ グループ内のタブをすべて閉じる"
    ]);
  });

  it("外側（バックドロップ）クリックで閉じる", async () => {
    const w = mountTabs();
    await w.find(".tg-chip").trigger("click");
    await w.find(".backdrop").trigger("click");
    expect(w.find(".menu").exists()).toBe(false);
  });

  it("名前を入力すると即反映され、色を選ぶと切り替わる", async () => {
    const tgId = workspaceStore.tabGroupOfTab("sql:query@own:a")!.id;
    const w = mountTabs();
    await w.find(".tg-chip").trigger("click");

    await w.find("input.name").setValue("検証作業");
    expect(workspaceStore.tabGroups[tgId]!.name).toBe("検証作業");

    await w.findAll(".swatch")[4]!.trigger("click");
    expect(workspaceStore.tabGroups[tgId]!.color).toBe(5);
  });

  it("グループ化を解除するとチップが消え、タブは残る", async () => {
    const w = mountTabs();
    await w.find(".tg-chip").trigger("click");
    await w.findAll(".item")[0]!.trigger("click");

    expect(Object.keys(workspaceStore.tabGroups)).toEqual([]);
    expect(workspaceStore.focusedGroup().tabs).toHaveLength(3);
    expect(w.find(".menu").exists()).toBe(false);
  });

  it("一括クローズは確認する。キャンセルすると 1 枚も閉じない", async () => {
    vi.stubGlobal("confirm", vi.fn().mockReturnValue(false));
    const w = mountTabs();
    await w.find(".tg-chip").trigger("click");
    await w.findAll(".item")[1]!.trigger("click");

    expect(globalThis.confirm).toHaveBeenCalledOnce();
    expect(vi.mocked(globalThis.confirm).mock.calls[0]![0]).toContain("2 枚");
    expect(workspaceStore.focusedGroup().tabs).toHaveLength(3);
  });

  it("確認を承認するとグループのタブだけが閉じる", async () => {
    vi.stubGlobal("confirm", vi.fn().mockReturnValue(true));
    const w = mountTabs();
    await w.find(".tg-chip").trigger("click");
    await w.findAll(".item")[1]!.trigger("click");

    expect(workspaceStore.focusedGroup().tabs).toEqual(["svc:list"]);
    expect(Object.keys(workspaceStore.tabGroups)).toEqual([]);
  });
});

describe("タブ帯の高さを増やさない（要件: 1px も高くしない）", () => {
  /**
   * **CSS の中身を走査して固定する。** jsdom は `<style scoped>` を適用しないので、
   * 実測では確かめられない。代わりに「メンバータブに**レイアウトを押し広げる宣言**を
   * 足さない」という規約そのものを検査する（`dependency-direction.test.ts` と同じ考え方）。
   */
  // パッケージ dir から実行する前提だが、ルートから叩かれても読めるようにする
  // （`chrome-marks.test.ts` / `grid-overlay-offset.test.ts` と同じ形）
  const REL = "src/components/PaneTabs.vue";
  const src = readFileSync(existsSync(REL) ? REL : `packages/web-ui/${REL}`, "utf8");

  /** そのセレクタのブロックが宣言しているプロパティ名 */
  function propsOf(selector: string): string[] {
    const at = src.indexOf(`\n${selector} {`);
    expect(at, `${selector} が見つからない`).toBeGreaterThan(-1);
    const body = src.slice(at + selector.length + 3, src.indexOf("}", at));
    return body
      .split(";")
      .map((d) => d.split(":")[0]!.trim())
      .filter((p) => p.length > 0 && !p.startsWith("/*"));
  }

  it("メンバータブは背景・内側の影・角丸だけを足す（border / padding / height を触らない）", () => {
    const allowed = new Set(["background", "box-shadow", "border-radius"]);
    for (const p of propsOf(".tab.tg-member")) {
      expect(allowed.has(p), `.tab.tg-member が ${p} を宣言している（帯が高くなる）`).toBe(true);
    }
  });

  it("重ねる予告も内側の影で出す（枠を足して押し広げない）", () => {
    const allowed = new Set(["box-shadow", "background"]);
    for (const p of propsOf(".tab.drop-into")) {
      expect(allowed.has(p), `.tab.drop-into が ${p} を宣言している`).toBe(true);
    }
  });

  it("チップはタブ帯の行高（28px）に収まる", () => {
    const height = /\.tg-chip \{[^}]*height:\s*(\d+)px/.exec(src);
    expect(height, "チップに固定高が無い").not.toBeNull();
    expect(Number(height![1])).toBeLessThanOrEqual(24); // 上下の余白ぶんを残す
  });

  it("タブ帯の最低高は 28px のまま（ヘッダーと共有する行高）", () => {
    expect(src).toContain("min-height: var(--chrome-row-h)");
    expect(src).toContain("min-height: 28px");
  });
});
