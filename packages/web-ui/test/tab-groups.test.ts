import { describe, it, expect, beforeEach } from "vitest";
import { workspaceStore } from "../src/stores/workspace.js";

/**
 * **タブグループ**（`20260804-tab-groups`）のストア側。
 *
 * 不変条件はすべて `normalizeTabGroups()` に集約してあるので、ここでは
 * 「どの経路を通っても不変条件が回復するか」を経路ごとに確かめる。
 */

/** そのペインの並び（テストの読みやすさのため） */
const tabsOf = (i = 0): string[] => workspaceStore.groups()[i]!.tabs;
/** いま存在するタブグループの id 一覧 */
const tgIds = (): string[] => Object.keys(workspaceStore.tabGroups);

describe("タブグループの作成・参加・離脱", () => {
  beforeEach(() => {
    workspaceStore.init();
    workspaceStore.addSession("s1");
    workspaceStore.addSession("s2");
    workspaceStore.addSession("s3"); // [s1, s2, s3]
  });

  it("2 枚を重ねるとグループができ、名前は空・色は 1 番から付く", () => {
    const g = workspaceStore.focusedGroup();
    workspaceStore.groupTabs(g.id, "s1", "s3");

    expect(tgIds()).toHaveLength(1);
    const tg = workspaceStore.tabGroupOfTab("s1")!;
    expect(tg.name).toBe("");
    expect(tg.color).toBe(1);
    expect(tg.collapsed).toBe(false);
    expect(workspaceStore.tabGroupOfTab("s3")!.id).toBe(tg.id);
    // **落とした先の隣へ寄る**（連続配置）
    expect(tabsOf()).toEqual(["s1", "s3", "s2"]);
  });

  it("グループ内のタブへ重ねると、そのグループへ参加する（新しい器を作らない）", () => {
    const g = workspaceStore.focusedGroup();
    workspaceStore.groupTabs(g.id, "s1", "s2");
    const tgId = workspaceStore.tabGroupOfTab("s1")!.id;

    workspaceStore.groupTabs(g.id, "s2", "s3");

    expect(tgIds()).toEqual([tgId]);
    expect(workspaceStore.tabGroupTabs(tgId)).toEqual(["s1", "s2", "s3"]);
  });

  it("2 つ目のグループには別の色が付く（使われていない最小の番号）", () => {
    workspaceStore.addSession("s4");
    const g = workspaceStore.focusedGroup();
    workspaceStore.groupTabs(g.id, "s1", "s2");
    workspaceStore.groupTabs(g.id, "s3", "s4");

    const colors = Object.values(workspaceStore.tabGroups).map((t) => t.color);
    expect(colors.sort()).toEqual([1, 2]);
  });

  it("グループの内側へ落とすと参加し、外へ落とすと離脱する（着地点の両隣で決まる）", () => {
    workspaceStore.addSession("s4"); // [s1, s2, s3, s4]
    const g = workspaceStore.focusedGroup();
    workspaceStore.groupTabs(g.id, "s1", "s2"); // [s1, s2, s3, s4]、G={s1,s2}
    const tgId = workspaceStore.tabGroupOfTab("s1")!.id;

    // s4 を s1 と s2 の間（＝グループの内側）へ
    workspaceStore.dropTabInto(g.id, "s4", 1);
    expect(workspaceStore.tabGroupOfTab("s4")!.id).toBe(tgId);
    expect(workspaceStore.tabGroupTabs(tgId)).toEqual(["s1", "s4", "s2"]);

    // s4 を末尾（＝グループの外）へ
    workspaceStore.dropTabInto(g.id, "s4", 3);
    expect(workspaceStore.tabGroupOfTab("s4")).toBeUndefined();
    expect(workspaceStore.tabGroupTabs(tgId)).toEqual(["s1", "s2"]);
  });

  it("グループの末尾の直後へ落としても参加しない（右隣がグループ外だから）", () => {
    workspaceStore.addSession("s4");
    const g = workspaceStore.focusedGroup();
    workspaceStore.groupTabs(g.id, "s1", "s2"); // G={s1,s2} が先頭
    workspaceStore.dropTabInto(g.id, "s4", 2); // s2 の直後

    expect(workspaceStore.tabGroupOfTab("s4")).toBeUndefined();
  });
});

describe("タブグループの自動解除（1 枚になったら器を残さない）", () => {
  beforeEach(() => {
    workspaceStore.init();
    workspaceStore.addSession("s1");
    workspaceStore.addSession("s2");
    workspaceStore.addSession("s3");
  });

  it("メンバーを閉じて 1 枚になったら解除される", () => {
    const g = workspaceStore.focusedGroup();
    workspaceStore.groupTabs(g.id, "s1", "s2");

    workspaceStore.closeSession("s2");

    expect(tgIds()).toEqual([]);
    expect(workspaceStore.tabGroupOfTab("s1")).toBeUndefined();
    expect(tabsOf()).toEqual(["s1", "s3"]);
  });

  it("メンバーをグループ外へ移して 1 枚になったら解除される", () => {
    const g = workspaceStore.focusedGroup();
    workspaceStore.groupTabs(g.id, "s1", "s2"); // [s1, s2, s3]

    workspaceStore.dropTabInto(g.id, "s2", 2); // 末尾（グループの外）へ

    expect(tgIds()).toEqual([]);
    expect(workspaceStore.tabGroupOfTab("s1")).toBeUndefined();
  });

  it("メンバーを別ペインへ移したら、移した側も残った側もグループから外れる", () => {
    const g = workspaceStore.focusedGroup();
    workspaceStore.groupTabs(g.id, "s1", "s2");

    workspaceStore.split(g.id, "right", "s2"); // s2 だけ新ペインへ

    expect(tgIds()).toEqual([]);
    expect(workspaceStore.tabGroupOfTab("s1")).toBeUndefined();
    expect(workspaceStore.tabGroupOfTab("s2")).toBeUndefined();
  });

  it("3 枚のうち 1 枚が抜けても、残り 2 枚ならグループは残る", () => {
    const g = workspaceStore.focusedGroup();
    workspaceStore.groupTabs(g.id, "s1", "s2");
    workspaceStore.groupTabs(g.id, "s2", "s3");
    const tgId = workspaceStore.tabGroupOfTab("s1")!.id;

    workspaceStore.closeSession("s3");

    expect(tgIds()).toEqual([tgId]);
    expect(workspaceStore.tabGroupTabs(tgId)).toEqual(["s1", "s2"]);
  });
});

describe("タブグループの連続配置", () => {
  beforeEach(() => {
    workspaceStore.init();
    for (const t of ["s1", "s2", "s3", "s4"]) workspaceStore.addSession(t);
  });

  it("グループの途中にグループ外のタブが割り込まない", () => {
    const g = workspaceStore.focusedGroup();
    workspaceStore.groupTabs(g.id, "s1", "s3"); // [s1, s3, s2, s4]、G={s1,s3}

    expect(tabsOf()).toEqual(["s1", "s3", "s2", "s4"]);
    const idx = tabsOf();
    expect(idx.indexOf("s3") - idx.indexOf("s1")).toBe(1);
  });

  it("メンバーが離れた位置にあっても正規化で寄せられる（最初のメンバーの位置へ）", () => {
    const g = workspaceStore.focusedGroup();
    workspaceStore.groupTabs(g.id, "s1", "s2"); // G={s1,s2}
    const tgId = workspaceStore.tabGroupOfTab("s1")!.id;
    // 内部状態を直接壊してから正規化する（外部からは作れない配置を検査する）
    workspaceStore.groups()[0]!.tabs = ["s1", "s3", "s2", "s4"];
    workspaceStore.tabGroupOf["s2"] = tgId;

    workspaceStore.normalizeTabGroups();

    expect(tabsOf()).toEqual(["s1", "s2", "s3", "s4"]);
  });
});

describe("折りたたみ", () => {
  beforeEach(() => {
    workspaceStore.init();
    for (const t of ["s1", "s2", "s3"]) workspaceStore.addSession(t);
  });

  it("畳むと visibleTabs から消えるが、tabs と activeTab は動かない", () => {
    const g = workspaceStore.focusedGroup();
    workspaceStore.groupTabs(g.id, "s1", "s2");
    const tgId = workspaceStore.tabGroupOfTab("s1")!.id;
    workspaceStore.setActiveTab(g.id, "s2");

    workspaceStore.toggleTabGroupCollapsed(tgId);

    // **隠すだけ**——tabs から外すとペインの実体が落ちて状態が消える
    expect(workspaceStore.visibleTabs(workspaceStore.focusedGroup())).toEqual(["s3"]);
    expect(tabsOf()).toEqual(["s1", "s2", "s3"]);
    // **アクティブタブに干渉しない**（畳んだ中身が出続ける。利用者の判断）
    expect(workspaceStore.focusedGroup().activeTab).toBe("s2");
  });

  it("展開すると元どおり現れる", () => {
    const g = workspaceStore.focusedGroup();
    workspaceStore.groupTabs(g.id, "s1", "s2");
    const tgId = workspaceStore.tabGroupOfTab("s1")!.id;

    workspaceStore.toggleTabGroupCollapsed(tgId);
    workspaceStore.toggleTabGroupCollapsed(tgId);

    expect(workspaceStore.visibleTabs(workspaceStore.focusedGroup())).toEqual(["s1", "s2", "s3"]);
  });

  it("畳んだ中のタブを setActiveTab で指名すると展開される（開いているのに出てこない、を防ぐ）", () => {
    const g = workspaceStore.focusedGroup();
    workspaceStore.groupTabs(g.id, "s1", "s2");
    const tgId = workspaceStore.tabGroupOfTab("s1")!.id;
    workspaceStore.toggleTabGroupCollapsed(tgId);

    workspaceStore.setActiveTab(g.id, "s1");

    expect(workspaceStore.tabGroups[tgId]!.collapsed).toBe(false);
  });

  it("cycleTab は畳んだタブも巡る（折りたたみは見せ方だけ・戻れなくならないように）", () => {
    const g = workspaceStore.focusedGroup();
    workspaceStore.groupTabs(g.id, "s1", "s2"); // [s1, s2, s3]
    const tgId = workspaceStore.tabGroupOfTab("s1")!.id;
    workspaceStore.toggleTabGroupCollapsed(tgId);
    workspaceStore.focusedGroup().activeTab = "s3";

    workspaceStore.cycleTab(1);

    expect(workspaceStore.focusedGroup().activeTab).toBe("s1");
    expect(workspaceStore.tabGroups[tgId]!.collapsed).toBe(true); // 巡回では展開しない
  });

  it("畳んだままメンバーが 1 枚になったら解除され、タブは現れる", () => {
    const g = workspaceStore.focusedGroup();
    workspaceStore.groupTabs(g.id, "s1", "s2");
    const tgId = workspaceStore.tabGroupOfTab("s1")!.id;
    workspaceStore.toggleTabGroupCollapsed(tgId);

    workspaceStore.closeSession("s2");

    expect(tgIds()).toEqual([]);
    expect(workspaceStore.visibleTabs(workspaceStore.focusedGroup())).toEqual(["s1", "s3"]);
  });
});

describe("名前と色", () => {
  beforeEach(() => {
    workspaceStore.init();
    workspaceStore.addSession("s1");
    workspaceStore.addSession("s2");
    workspaceStore.groupTabs(workspaceStore.focusedGroup().id, "s1", "s2");
  });

  it("名前を付けて空に戻せる", () => {
    const tgId = workspaceStore.tabGroupOfTab("s1")!.id;
    workspaceStore.renameTabGroup(tgId, "検証作業");
    expect(workspaceStore.tabGroups[tgId]!.name).toBe("検証作業");
    workspaceStore.renameTabGroup(tgId, "");
    expect(workspaceStore.tabGroups[tgId]!.name).toBe("");
  });

  it("色は 1..8 のみ受け付け、範囲外は元の値を保つ（壊れた値で色を消さない）", () => {
    const tgId = workspaceStore.tabGroupOfTab("s1")!.id;
    workspaceStore.setTabGroupColor(tgId, 5);
    expect(workspaceStore.tabGroups[tgId]!.color).toBe(5);
    workspaceStore.setTabGroupColor(tgId, 99);
    expect(workspaceStore.tabGroups[tgId]!.color).toBe(5);
  });

  it("グループ化を解除してもタブは残り、並びも変わらない", () => {
    const tgId = workspaceStore.tabGroupOfTab("s1")!.id;
    workspaceStore.ungroupTabGroup(tgId);

    expect(tgIds()).toEqual([]);
    expect(tabsOf()).toEqual(["s1", "s2"]);
    expect(workspaceStore.tabGroupOfTab("s1")).toBeUndefined();
  });
});

describe("グループごとの移動", () => {
  beforeEach(() => {
    workspaceStore.init();
    for (const t of ["a1", "a2", "a3"]) workspaceStore.addSession(t);
    const g0 = workspaceStore.focusedGroup();
    workspaceStore.groupTabs(g0.id, "a1", "a2"); // G={a1,a2}
    workspaceStore.split(g0.id, "right", "a3"); // 左[a1,a2] | 右[a3]
  });

  it("別ペインのタブ帯へ落とすと、グループのまま移る（名前・色・並びを保つ）", () => {
    const tgId = workspaceStore.tabGroupOfTab("a1")!.id;
    workspaceStore.renameTabGroup(tgId, "検証");
    workspaceStore.setTabGroupColor(tgId, 3);
    const right = workspaceStore.groups().find((g) => g.tabs.includes("a3"))!;

    workspaceStore.moveTabGroupInto(right.id, tgId);

    expect(workspaceStore.groups()).toHaveLength(1); // 元ペインは空 → 片付く
    expect(tabsOf()).toEqual(["a3", "a1", "a2"]);
    expect(workspaceStore.tabGroups[tgId]!.name).toBe("検証");
    expect(workspaceStore.tabGroups[tgId]!.color).toBe(3);
    expect(workspaceStore.tabGroupTabs(tgId)).toEqual(["a1", "a2"]);
  });

  it("畳んだグループを移しても畳んだままで、表示中のタブを勝手に切り替えない", () => {
    const tgId = workspaceStore.tabGroupOfTab("a1")!.id;
    workspaceStore.toggleTabGroupCollapsed(tgId);
    const right = workspaceStore.groups().find((g) => g.tabs.includes("a3"))!;

    workspaceStore.moveTabGroupInto(right.id, tgId);

    expect(workspaceStore.tabGroups[tgId]!.collapsed).toBe(true);
    expect(workspaceStore.groups()[0]!.activeTab).toBe("a3");
  });

  it("ペインの端へ落とすと分割され、グループごと新ペインへ移る", () => {
    const tgId = workspaceStore.tabGroupOfTab("a1")!.id;
    const right = workspaceStore.groups().find((g) => g.tabs.includes("a3"))!;

    workspaceStore.splitWithTabGroup(right.id, "bottom", tgId);

    expect(workspaceStore.isSplit()).toBe(true);
    const holder = workspaceStore.groups().find((g) => g.tabs.includes("a1"))!;
    expect(holder.tabs).toEqual(["a1", "a2"]);
    expect(holder.tabs).not.toContain("a3");
    expect(workspaceStore.tabGroupTabs(tgId)).toEqual(["a1", "a2"]);
  });

  it("狭幅では分割せず合流へ倒す（単独タブの split と同じ方針）", () => {
    const tgId = workspaceStore.tabGroupOfTab("a1")!.id;
    const right = workspaceStore.groups().find((g) => g.tabs.includes("a3"))!;
    workspaceStore.narrow = true;

    workspaceStore.splitWithTabGroup(right.id, "left", tgId);
    workspaceStore.narrow = false;

    expect(workspaceStore.groups()).toHaveLength(1);
    expect(tabsOf()).toEqual(["a3", "a1", "a2"]);
  });

  it("グループは 1 つのペインにしか存在しない（INV-TG1: 跨ったら正規化で片側へ寄せる）", () => {
    const tgId = workspaceStore.tabGroupOfTab("a1")!.id;
    const right = workspaceStore.groups().find((g) => g.tabs.includes("a3"))!;
    // 内部状態を直接壊す（外部の操作では作れない配置）
    right.tabs = [...right.tabs, "a2"];
    workspaceStore.groups()[0]!.tabs = ["a1"];

    workspaceStore.normalizeTabGroups();

    const owners = workspaceStore
      .groups()
      .filter((g) => g.tabs.some((t) => workspaceStore.tabGroupOf[t] === tgId));
    expect(owners.length).toBeLessThanOrEqual(1);
  });
});
