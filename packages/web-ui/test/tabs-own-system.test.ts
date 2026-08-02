import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import App from "../src/App.vue";
import PaneTabs from "../src/components/PaneTabs.vue";
import { workspaceStore } from "../src/stores/workspace.js";
import { systemsStore } from "../src/stores/systems.js";
import { makePaneTabId, splitPaneTabId, paneLabelOf, isPaneTab } from "../src/paneLabels.js";
import { systemColorIndex, autoSystemColor, SYSTEM_COLOR_COUNT } from "../src/composables/systemColor.js";
import { resetOpenedPanes } from "../src/composables/openedPanes.js";
import { MSG_SYSTEM_GONE } from "../src/composables/opMessages.js";

/**
 * **タブがシステムを持つ**（`20260802-tabs-own-system`）。
 *
 * 宛先そのものは `pane-system-binding.test.ts` が守る。ここが守るのはその周り:
 * タブ ID の形／(機能, システム) ごとに別のタブ／見分け（色と名前）／
 * メニューの対象／消えたシステムの扱い。
 */

const A = { ref: "own:a", name: "エー", host: "h", autoSignon: false };
const B = { ref: "own:b", name: "ビー", host: "h", autoSignon: false };

beforeEach(() => {
  resetOpenedPanes();
  workspaceStore.init();
  workspaceStore.tabSystem = {};
  systemsStore.systems = [A, B];
  systemsStore.sessions = [];
  systemsStore.loaded = true;
  systemsStore.select(A.ref);
  workspaceStore.showLauncher = false;
  workspaceStore.showSystemPicker = false;
});
afterEach(() => {
  systemsStore.systems = [];
  systemsStore.select(undefined);
});

describe("タブ ID", () => {
  it("組み立てと分解が往復する", () => {
    const id = makePaneTabId("sql:query", A.ref);
    expect(id).toBe("sql:query@own:a");
    expect(splitPaneTabId(id)).toEqual({ feature: "sql:query", system: A.ref });
  });

  it("**`:` では分解できないので `@` を使う**（機能 ID にもシステム ref にも `:` が入る）", () => {
    const { feature, system } = splitPaneTabId("sql:query@own:a");
    expect(feature, "機能側の `:` で切れている").toBe("sql:query");
    expect(system, "システム側の `:` で切れている").toBe("own:a");
  });

  it("接頭辞の判定とラベル引きは `@` 付きでも効く", () => {
    const id = makePaneTabId("sql:query", A.ref);
    expect(isPaneTab(id)).toBe(true);
    expect(paneLabelOf(id)).toBe("SQL");
  });

  it("システムに紐づかない画面は素の ID のまま", () => {
    expect(splitPaneTabId("svc:services")).toEqual({ feature: "svc:services" });
    expect(paneLabelOf("svc:services")).toBe("サービス");
  });
});

describe("システムカラー", () => {
  it("**未設定でも色が付く**（ref から決定的に）", () => {
    const n = systemColorIndex(A.ref);
    expect(n).toBeGreaterThanOrEqual(1);
    expect(n).toBeLessThanOrEqual(SYSTEM_COLOR_COUNT);
    expect(systemColorIndex(A.ref), "同じ ref で毎回違う色になる").toBe(n);
  });

  it("設定値があればそれを使う", () => {
    expect(systemColorIndex(A.ref, 5)).toBe(5);
  });

  it("**壊れた設定は自動に倒す**（色が消えるより何か付くほうがよい）", () => {
    for (const bad of [0, 9, -1, 1.5, NaN]) {
      expect(systemColorIndex(A.ref, bad)).toBe(autoSystemColor(A.ref));
    }
  });

  it("ストアは設定値を優先し、無ければ自動", () => {
    systemsStore.systems = [{ ...A, color: 3 }, B];
    expect(systemsStore.colorOf(A.ref)).toBe(3);
    expect(systemsStore.colorOf(B.ref)).toBe(autoSystemColor(B.ref));
  });
});

describe("タブの見分け", () => {
  function mountTabs() {
    const g = workspaceStore.focusedGroup();
    return { w: mount(PaneTabs, { props: { group: g } }), g };
  }

  it("システムカラーの帯がタブに付く", () => {
    const g = workspaceStore.focusedGroup();
    const tab = makePaneTabId("sql:query", A.ref);
    g.tabs = [tab];
    g.activeTab = tab;
    const { w } = mountTabs();
    const style = w.find(".tab").attributes("style") ?? "";
    expect(style).toContain(`--sys-${systemsStore.colorOf(A.ref)}`);
    w.unmount();
  });

  it("**1 システムだけならシステム名は出さない**（今までの見た目を変えない）", () => {
    const g = workspaceStore.focusedGroup();
    g.tabs = [makePaneTabId("sql:query", A.ref), makePaneTabId("ifs:files", A.ref)];
    g.activeTab = g.tabs[0];
    const { w } = mountTabs();
    expect(w.find(".sysname").exists()).toBe(false);
    w.unmount();
  });

  it("**2 システム以上開いたらシステム名が出る**", () => {
    const g = workspaceStore.focusedGroup();
    g.tabs = [makePaneTabId("sql:query", A.ref), makePaneTabId("sql:query", B.ref)];
    g.activeTab = g.tabs[0];
    const { w } = mountTabs();
    const names = w.findAll(".sysname").map((n) => n.text());
    expect(names).toEqual([A.name, B.name]);
    w.unmount();
  });

  it("判定はワークスペース全体（別ペインへ移してもラベルが伸び縮みしない）", () => {
    const g0 = workspaceStore.focusedGroup();
    const sqlA = makePaneTabId("sql:query", A.ref);
    // **2 枚置いてから割る。** 1 枚だけだと元グループが空になり `pruneEmpty` で消える
    g0.tabs = [sqlA, makePaneTabId("ifs:files", B.ref)];
    g0.activeTab = sqlA;
    workspaceStore.split(g0.id, "right", sqlA);
    const groups = workspaceStore.groups();
    expect(groups, "分割できていない").toHaveLength(2);
    const right = groups.find((g) => g.tabs.includes(sqlA))!;

    // **右のペインには A のタブしか無い**のに、全体では 2 システムなので名前は出る
    expect(right.tabs).toEqual([sqlA]);
    const w = mount(PaneTabs, { props: { group: right } });
    expect(w.find(".sysname").exists()).toBe(true);
    w.unmount();
  });
});

describe("(機能, システム) ごとに別のタブ", () => {
  /**
   * **App をマウントしてから組む。** `App.vue` は `<script setup>` の中で
   * `workspaceStore.init()` を呼ぶので、先に組むとマウントで消える（何度か踏んだ）。
   */
  async function openMenu() {
    const w = mount(App, { attachTo: document.body });
    workspaceStore.showLauncher = true;
    await nextTick();
    return w;
  }
  /**
   * メニューを開いたまま対象システムを選び、機能カードの「開く」を押す。
   * **切替はメニューを開いている間に行う**——対象は「開いた時点」で固定されるので、
   * 閉じた状態で選び直しても次に開いたときに見ているタブへ揃え直される（それが仕様）。
   */
  async function openFeature(w: ReturnType<typeof mount>, sys: string, name: string) {
    systemsStore.select(sys);
    await nextTick();
    const card = w.findAll(".fn").find((c) => c.find(".nm").text() === name)!;
    await card.find("button").trigger("click");
    await nextTick();
    return card;
  }

  it("**A の SQL と B の SQL は別のタブになる**", async () => {
    const w = await openMenu();
    await openFeature(w, A.ref, "SQL");
    expect(workspaceStore.focusedGroup().tabs).toEqual([makePaneTabId("sql:query", A.ref)]);

    workspaceStore.showLauncher = true;
    await nextTick();
    await openFeature(w, B.ref, "SQL");

    expect(workspaceStore.focusedGroup().tabs).toEqual([
      makePaneTabId("sql:query", A.ref),
      makePaneTabId("sql:query", B.ref)
    ]);
    w.unmount();
  });

  it("**開き直してもシステムが付け替わらない**（同じ組は前面に出るだけ）", async () => {
    const w = await openMenu();
    await openFeature(w, A.ref, "SQL");
    const before = [...workspaceStore.focusedGroup().tabs];

    workspaceStore.showLauncher = true;
    await nextTick();
    const card = await openFeature(w, A.ref, "SQL");
    expect(card.find("button").text(), "既に開いているのに「開く」のまま").toBe("表示");

    expect(workspaceStore.focusedGroup().tabs).toEqual(before);
    w.unmount();
  });
});

describe("メニューの対象", () => {
  /**
   * **タブを選び替えただけでヘッダーが変わる**（`20260802-header-follows-tab`・利用者の指摘）。
   *
   * 以前はメニューを開いた瞬間にだけ合わせていたので、**A のタブを見ているのに
   * ヘッダーは B**、という食い違いが起きていた。異なるシステムのタブを並べられる以上、
   * ヘッダーは「いまどのシステムを見ているか」を常に正しく出す必要がある。
   */
  it("**タブを選び替えるとヘッダーのシステムが変わる**（メニューを開かなくても）", async () => {
    const w = mount(App, { attachTo: document.body });
    const g = workspaceStore.focusedGroup();
    g.tabs = [makePaneTabId("sql:query", A.ref), makePaneTabId("sql:query", B.ref)];
    g.activeTab = g.tabs[0];
    await nextTick();
    expect(systemsStore.menuSystem).toBe(A.ref);

    g.activeTab = g.tabs[1];
    await nextTick();
    expect(systemsStore.menuSystem, "タブを移ってもヘッダーが変わらない").toBe(B.ref);

    // パンくずの表示もそのシステムになっている
    expect(w.find(".crumbs .crumb").text()).toContain(B.name);
    w.unmount();
  });

  it("**別のペインへフォーカスを移してもヘッダーが追う**", async () => {
    const w = mount(App, { attachTo: document.body });
    const g0 = workspaceStore.focusedGroup();
    const sqlA = makePaneTabId("sql:query", A.ref);
    g0.tabs = [sqlA, makePaneTabId("ifs:files", B.ref)];
    g0.activeTab = sqlA;
    await nextTick();
    workspaceStore.split(g0.id, "right", sqlA);
    await nextTick();
    const groups = workspaceStore.groups();
    const left = groups.find((x) => !x.tabs.includes(sqlA))!;
    const right = groups.find((x) => x.tabs.includes(sqlA))!;

    workspaceStore.focus(right.id);
    await nextTick();
    expect(systemsStore.menuSystem).toBe(A.ref);

    workspaceStore.focus(left.id);
    await nextTick();
    expect(systemsStore.menuSystem, "ペインを移ってもヘッダーが変わらない").toBe(B.ref);
    w.unmount();
  });

  it("**開いている最中にフォーカスが変わっても対象は動かない**（押した先が入れ替わらない）", async () => {
    const w = mount(App, { attachTo: document.body });
    const g = workspaceStore.focusedGroup();
    g.tabs = [makePaneTabId("sql:query", A.ref), makePaneTabId("sql:query", B.ref)];
    g.activeTab = g.tabs[0];
    await nextTick();

    workspaceStore.showLauncher = true;
    await nextTick();
    expect(systemsStore.menuSystem).toBe(A.ref);

    // メニューを開いたままアクティブタブが変わっても……
    g.activeTab = g.tabs[1];
    await nextTick();
    expect(systemsStore.menuSystem, "開いている間に対象が動いた").toBe(A.ref);
    w.unmount();
  });

  it("システムを持たないタブのときは直前の対象を維持する", async () => {
    const w = mount(App, { attachTo: document.body });
    const g = workspaceStore.focusedGroup();
    g.tabs = ["svc:services"];
    g.activeTab = "svc:services";
    systemsStore.select(B.ref);
    await nextTick();

    workspaceStore.showLauncher = true;
    await nextTick();
    expect(systemsStore.menuSystem).toBe(B.ref);
    w.unmount();
  });
});

describe("システムが設定から消えたタブ", () => {
  it("**銘板が出て、ペインには宛先を渡さない**（黙って別システムへ飛ばさない）", async () => {
    const tab = makePaneTabId("transfer:data", A.ref);
    const w = mount(App, { attachTo: document.body });
    const g = workspaceStore.focusedGroup();
    g.tabs = [tab];
    g.activeTab = tab;
    await nextTick();
    await nextTick();
    expect(w.findAllComponents({ name: "TransferPane" })[0]!.props("system")).toBe(A.ref);

    // A を設定から消す
    systemsStore.systems = [B];
    await nextTick();

    expect(w.text()).toContain(MSG_SYSTEM_GONE);
    expect(
      w.findAllComponents({ name: "TransferPane" })[0]!.props("system"),
      "消えたのに宛先を渡している"
    ).toBeUndefined();
    // **タブは閉じない**（書きかけの内容ごと消さない）
    expect(workspaceStore.focusedGroup().tabs).toEqual([tab]);
    w.unmount();
  });
});

/**
 * **パンくず第 1 段の見た目**（`20260802-crumb-system-spacing`・利用者の指摘）。
 *
 * 色の点が挟まったので、区切りの `:` は要らなくなった。段の高さ揃えと余白は CSS の話で
 * jsdom では測れないため（`verify-view-cascade.mjs` の隣で実測している）、
 * ここでは**文字として `:` が戻ってこないこと**だけを固定する。
 */
describe("パンくずの「システム」段", () => {
  it("**区切りの `:` を出さない**（色の点がその役目を果たしている）", async () => {
    const w = mount(App, { attachTo: document.body });
    systemsStore.select(A.ref);
    await nextTick();
    const crumb = w.find(".crumbs .crumb");
    expect(crumb.text()).toContain("システム");
    expect(crumb.text(), "区切りの `:` が戻っている").not.toContain("システム:");
    w.unmount();
  });
});
