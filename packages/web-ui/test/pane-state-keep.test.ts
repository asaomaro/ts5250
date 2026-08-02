import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import App from "../src/App.vue";
import { workspaceStore } from "../src/stores/workspace.js";
import { systemsStore } from "../src/stores/systems.js";
import { resetOpenedPanes } from "../src/composables/openedPanes.js";

/**
 * **開いたタブは閉じるまで生かす**（`20260802-keep-pane-state` ＋ `-move`）。
 *
 * アクティブなタブのペインだけを描いていた頃は、切り替えるたびにアンマウントされ、
 * **コンポーネントのローカル状態が丸ごと消えていた**（利用者の指摘: 書きかけの SQL、
 * IFS の居場所、一覧の絞り込み……）。5250 だけ無事に見えたのは、状態が
 * `sessionsStore` にあって再マウントで描き直せるから。
 *
 * ここで守るのは:
 *
 * 1. **タブを切り替えても**入力が残る
 * 2. **メニューへ寄っても・システムを選び直しても**残る
 * 3. **最大化・解除をしても**残る（木を差し替えない）
 * 4. **タブを別グループへ移しても・端に落として分割しても**残る（実体は `PanePool` が持つ）
 * 5. 一度も開いていないタブは作らない／閉じたら消える（後片付けが走る）
 * 6. 隠れているペインには `active=false` が伝わる（裏で働き続けない）
 *
 * 足場は `transfer:data` と `dtaq:entries`——どちらも**マウント時に問い合わせを出さない**
 * ので、状態の保持だけを見られる。
 *
 * **`attachTo: document.body` が要る。** 実体は `<Teleport>` で受け皿へ差し込むので、
 * 差し込み先を `document.querySelector` で探す——外れた木ではセレクタが当たらない。
 */

const SYS_A = { ref: "own:a", name: "A", host: "h", autoSignon: false };
const SYS_B = { ref: "own:b", name: "B", host: "h", autoSignon: false };

/**
 * **App をマウントしてからワークスペースを組む。**
 * `App.vue` は `<script setup>` の中で `workspaceStore.init()` を呼ぶ——setup は
 * インスタンス生成のたびに走るので、先に組むとマウントで消される（実際に踏んだ）。
 */
async function setup(tabs: string[] = ["transfer:data", "dtaq:entries"]) {
  systemsStore.systems = [SYS_A, SYS_B];
  systemsStore.sessions = [];
  systemsStore.loaded = true;
  systemsStore.select(SYS_A.ref);
  const w = mount(App, { attachTo: document.body });
  const g = workspaceStore.focusedGroup();
  g.tabs = [...tabs];
  g.activeTab = tabs[0];
  for (const t of tabs) workspaceStore.tabSystem[t] = SYS_A.ref;
  workspaceStore.showLauncher = false;
  await nextTick();
  await nextTick();
  return w;
}

type W = Awaited<ReturnType<typeof setup>>;

/** そのタブの受け皿（作られていなければ undefined） */
function slot(w: W, tab: string) {
  const el = w.find(`.pane-slot[data-tab="${tab}"]`);
  return el.exists() ? el : undefined;
}
/** 見えているか。`v-show` は要素のインライン style を直接触る（jsdom は CSS を計算しない） */
const shown = (el: ReturnType<typeof slot>): boolean =>
  el !== undefined && (el.element as HTMLElement).style.display !== "none";
/** そのタブのペインの最初の入力欄（＝実体が生きている証拠でもある） */
const input = (w: W, tab: string) => w.find(`.pane-slot[data-tab="${tab}"] input`);
const valueOf = (w: W, tab: string) => (input(w, tab).element as HTMLInputElement).value;
/** その受け皿が属するグループ id */
const slotGroup = (w: W, tab: string) =>
  slot(w, tab)?.attributes("data-pane-slot")?.split("/")[0];

beforeEach(() => {
  resetOpenedPanes();
  workspaceStore.tabSystem = {};
});
afterEach(() => {
  workspaceStore.showLauncher = false;
  workspaceStore.showSystemPicker = false;
  workspaceStore.maximizedGroupId = undefined;
});

describe("タブを切り替えても状態を失わない", () => {
  it("**書いた内容が残る**（切り替えて戻る）", async () => {
    const w = await setup();
    const g = workspaceStore.focusedGroup();
    await input(w, "transfer:data").setValue("MYLIB");

    g.activeTab = "dtaq:entries";
    await nextTick();
    expect(shown(slot(w, "transfer:data")), "隠れていない").toBe(false);
    expect(shown(slot(w, "dtaq:entries")), "移った先が見えていない").toBe(true);

    g.activeTab = "transfer:data";
    await nextTick();
    expect(valueOf(w, "transfer:data")).toBe("MYLIB");
    w.unmount();
  });

  it("**一度も開いていないタブは作らない**（起動時に全部問い合わせない）", async () => {
    const w = await setup();
    expect(slot(w, "transfer:data"), "アクティブなタブが無い").toBeDefined();
    expect(slot(w, "dtaq:entries"), "開いてもいないタブを作っている").toBeUndefined();
    w.unmount();
  });

  it("**閉じたら消える**（後片付けが走る＝KeepAlive にしない理由）", async () => {
    const w = await setup();
    const g = workspaceStore.focusedGroup();
    g.activeTab = "dtaq:entries";
    await nextTick();
    expect(slot(w, "transfer:data")).toBeDefined();

    g.tabs = g.tabs.filter((t) => t !== "transfer:data");
    await nextTick();
    expect(slot(w, "transfer:data"), "閉じたのに残っている").toBeUndefined();
    expect(w.findAllComponents({ name: "TransferPane" }), "実体が残っている").toHaveLength(0);
    w.unmount();
  });

  it("**隠れているペインには見えていないと伝える**（裏で働き続けないため）", async () => {
    const w = await setup();
    workspaceStore.focusedGroup().activeTab = "dtaq:entries";
    await nextTick();
    const panes = w.findAllComponents({ name: "TransferPane" });
    expect(panes).toHaveLength(1);
    expect(panes[0]!.props("active")).toBe(false);
    expect(w.findAllComponents({ name: "DtaqPane" })[0]!.props("active")).toBe(true);
    w.unmount();
  });

  it("5250 は従来どおりアクティブな 1 つだけ（画面の DOM が大きいので常時は持たない）", async () => {
    const w = await setup(["sess-1", "transfer:data"]);
    expect(w.findAll(".pane-slot")).toHaveLength(0);
    workspaceStore.focusedGroup().activeTab = "transfer:data";
    await nextTick();
    expect(w.findAll(".pane-slot")).toHaveLength(1);
    w.unmount();
  });
});

/**
 * **メニューへ寄っても、別のシステムを選んでも残す**（利用者の追加指示）。
 *
 * `App.vue` はワークスペースを `v-if="!showLauncher"` で切っていた。メニューへ移るだけ、
 * システムを選び直すだけで**ペインが丸ごとアンマウント**されていた——`showLauncher` は
 * 「明示的にメニューを開いた」ときだけでなく**「選択中システムに見えるタブが無い」ときにも真**
 * になるため、システム切替でも同じことが起きる。
 */
describe("メニュー・システム切替をまたいでも残す", () => {
  it("**メニューへ寄って戻っても書いた内容が残る**", async () => {
    const w = await setup();
    await input(w, "transfer:data").setValue("KEEPME");

    workspaceStore.showLauncher = true; // パンくずの「メニュー」
    await nextTick();
    expect(slot(w, "transfer:data"), "メニューで消えている").toBeDefined();

    workspaceStore.showLauncher = false;
    await nextTick();
    expect(valueOf(w, "transfer:data")).toBe("KEEPME");
    w.unmount();
  });

  it("**別のシステムを選んでも残る**（見えるタブが無くなってメニューが出る場面）", async () => {
    const w = await setup();
    await input(w, "transfer:data").setValue("KEEPME");

    systemsStore.select(SYS_B.ref); // B に属するタブは無い＝ランチャーが出る
    await nextTick();
    expect(slot(w, "transfer:data"), "システム切替で消えている").toBeDefined();

    systemsStore.select(SYS_A.ref);
    await nextTick();
    expect(valueOf(w, "transfer:data")).toBe("KEEPME");
    w.unmount();
  });

  it("メニューを出している間は「見えていない」と伝える（裏で働かせない）", async () => {
    const w = await setup();
    workspaceStore.showLauncher = true;
    await nextTick();
    expect(w.findAllComponents({ name: "TransferPane" })[0]!.props("active")).toBe(false);
    w.unmount();
  });
});

/**
 * **最大化・タブ移動でも残す**（`20260802-keep-pane-state-move`・利用者の追加指示）。
 *
 * - 最大化: `App` が `displayRoot()`（最大化中はそのグループだけ）を描いていたので、
 *   **描く木が入れ替わって全ペインが作り直されていた**。
 * - タブ移動: ペインを**そのグループ**が描いていたので、移すと作り直されていた。
 *   実体を `PanePool` へ移し、`<Teleport>` で受け皿へ差し込む形にした。
 */
describe("最大化・タブ移動をまたいでも残す", () => {
  /** 左右 2 分割にし、左に `dtaq:entries` / 右に `transfer:data` を置く */
  async function splitTwo(w: W) {
    const g = workspaceStore.focusedGroup();
    workspaceStore.split(g.id, "right", "transfer:data"); // 右へ切り出す
    await nextTick();
    const [left, right] = workspaceStore.groups();
    left!.tabs = ["dtaq:entries"];
    left!.activeTab = "dtaq:entries";
    await nextTick();
    await nextTick();
    return { left: left!, right: right! };
  }

  it("**分割（端へのドロップ）でも実体が作り直されない**", async () => {
    const w = await setup(["transfer:data"]);
    await input(w, "transfer:data").setValue("SPLITME");
    const before = w.findAllComponents({ name: "TransferPane" })[0]!.element;

    const g = workspaceStore.focusedGroup();
    workspaceStore.split(g.id, "right", "transfer:data");
    await nextTick();
    await nextTick();

    expect(valueOf(w, "transfer:data")).toBe("SPLITME");
    expect(
      w.findAllComponents({ name: "TransferPane" })[0]!.element,
      "実体が作り直されている（同じ DOM ではない）"
    ).toBe(before);
    w.unmount();
  });

  it("**別グループへ移しても入力が残る**（受け皿だけが動く）", async () => {
    const w = await setup(["transfer:data", "dtaq:entries"]);
    await input(w, "transfer:data").setValue("MOVEME");
    const { left, right } = await splitTwo(w);
    expect(slotGroup(w, "transfer:data"), "分割で右へ出ていない").toBe(right.id);

    workspaceStore.moveTab("transfer:data", left.id);
    await nextTick();
    await nextTick();
    expect(slotGroup(w, "transfer:data"), "受け皿が移っていない").toBe(left.id);
    expect(valueOf(w, "transfer:data")).toBe("MOVEME");
    w.unmount();
  });

  it("**最大化・解除で両側の入力が残る**", async () => {
    const w = await setup(["transfer:data", "dtaq:entries"]);
    await input(w, "transfer:data").setValue("RIGHT");
    workspaceStore.focusedGroup().activeTab = "dtaq:entries";
    await nextTick();
    await input(w, "dtaq:entries").setValue("LEFT");
    const { right } = await splitTwo(w);

    workspaceStore.toggleMaximize(right.id);
    await nextTick();
    expect(valueOf(w, "transfer:data")).toBe("RIGHT");
    // 最大化中も反対側は作り直されない（隠れているだけ）
    expect(valueOf(w, "dtaq:entries"), "隠した側が作り直されている").toBe("LEFT");

    workspaceStore.toggleMaximize(right.id); // 解除
    await nextTick();
    expect(valueOf(w, "transfer:data")).toBe("RIGHT");
    expect(valueOf(w, "dtaq:entries")).toBe("LEFT");
    w.unmount();
  });

  it("最大化中は反対側と仕切りを隠す（木も比率も書き換えない）", async () => {
    const w = await setup(["transfer:data", "dtaq:entries"]);
    const { right } = await splitTwo(w);
    const children = () => w.findAll(".split > .split-child");
    const divider = () => w.find(".split > .divider");
    const visible = () => children().filter((c) => (c.element as HTMLElement).style.display !== "none");
    expect(children()).toHaveLength(2);

    workspaceStore.toggleMaximize(right.id);
    await nextTick();
    expect(visible(), "1 枚に畳めていない").toHaveLength(1);
    expect((visible()[0]!.element as HTMLElement).style.flexBasis).toBe("100%");
    expect((divider().element as HTMLElement).style.display).toBe("none");

    workspaceStore.toggleMaximize(right.id);
    await nextTick();
    expect(visible()).toHaveLength(2);
    expect((divider().element as HTMLElement).style.display).not.toBe("none");
    w.unmount();
  });
});
