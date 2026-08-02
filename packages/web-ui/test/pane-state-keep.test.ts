import { describe, it, expect, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import App from "../src/App.vue";
import WorkspaceNode from "../src/components/WorkspaceNode.vue";
import { workspaceStore, type GroupNode } from "../src/stores/workspace.js";
import { systemsStore } from "../src/stores/systems.js";

/**
 * **開いたタブは閉じるまで生かす**（`20260802-keep-pane-state`）。
 *
 * 以前はアクティブなタブのペインだけを描いていたので、切り替えるたびにアンマウントされ、
 * **コンポーネントのローカル状態が丸ごと消えていた**（利用者の指摘: 書きかけの SQL、
 * IFS の居場所、一覧の絞り込み……）。5250 だけ無事に見えたのは、状態が
 * `sessionsStore` にあって再マウントで描き直せるから。
 *
 * ここで守るのは 4 点:
 *
 * 1. 切り替えても**前のペインが生きていて、入力が残る**
 * 2. **一度も開いていないタブは作らない**（起動時に全タブぶんの問い合わせを飛ばさない）
 * 3. **閉じたら本当に消える**（`onUnmounted` の後片付けが走る＝`<KeepAlive>` にしない理由）
 * 4. 隠れているペインには `active=false` が伝わる（裏で働き続けないため）
 *
 * 足場に選んだのは `transfer:data` と `dtaq:entries`——どちらも
 * **マウント時に問い合わせを出さない**ので、状態の保持だけを見られる。
 */

/** 単一グループのワークスペースを組み、そのグループを返す */
function makeGroup(tabs: string[]): GroupNode {
  workspaceStore.init();
  const g = workspaceStore.focusedGroup();
  g.tabs = [...tabs];
  g.activeTab = tabs[0];
  return g;
}

const mountNode = (g: GroupNode) => mount(WorkspaceNode, { props: { node: g } });

/** そのタブの包み紙（マウントされていなければ undefined） */
function slot(w: ReturnType<typeof mountNode>, tab: string) {
  const el = w.find(`.pane-slot[data-tab="${tab}"]`);
  return el.exists() ? el : undefined;
}
/** 見えているか。`v-show` は要素のインライン style を直接触る（jsdom は CSS を計算しない） */
const shown = (el: ReturnType<typeof slot>): boolean =>
  el !== undefined && (el.element as HTMLElement).style.display !== "none";

beforeEach(() => {
  systemsStore.systems = [];
  systemsStore.sessions = [];
  systemsStore.loaded = true;
});

describe("タブを切り替えても状態を失わない", () => {
  it("**書いた内容が残る**（切り替えて戻る）", async () => {
    const g = makeGroup(["transfer:data", "dtaq:entries"]);
    const w = mountNode(g);
    await nextTick();

    // データ転送のライブラリー欄に打つ
    const lib = () => w.find(".pane-slot[data-tab='transfer:data'] input");
    await lib().setValue("MYLIB");

    // 待ち行列タブへ移る
    g.activeTab = "dtaq:entries";
    await nextTick();
    expect(shown(slot(w, "transfer:data")), "隠れていない").toBe(false);
    expect(shown(slot(w, "dtaq:entries")), "移った先が見えていない").toBe(true);

    // 戻ると打った内容がそのまま
    g.activeTab = "transfer:data";
    await nextTick();
    expect((lib().element as HTMLInputElement).value).toBe("MYLIB");
    w.unmount();
  });

  it("**一度も開いていないタブは作らない**（起動時に全部問い合わせない）", async () => {
    const g = makeGroup(["transfer:data", "dtaq:entries"]);
    const w = mountNode(g);
    await nextTick();
    expect(slot(w, "transfer:data"), "アクティブなタブが無い").toBeDefined();
    expect(slot(w, "dtaq:entries"), "開いてもいないタブを作っている").toBeUndefined();
    w.unmount();
  });

  it("**閉じたら消える**（後片付けが走る＝KeepAlive にしない理由）", async () => {
    const g = makeGroup(["transfer:data", "dtaq:entries"]);
    const w = mountNode(g);
    await nextTick();
    g.activeTab = "dtaq:entries";
    await nextTick();
    expect(slot(w, "transfer:data")).toBeDefined();

    // タブを閉じる＝グループの tabs から外れる
    g.tabs = g.tabs.filter((t) => t !== "transfer:data");
    await nextTick();
    expect(slot(w, "transfer:data"), "閉じたのに残っている").toBeUndefined();
    w.unmount();
  });

  it("**隠れているペインには見えていないと伝える**（裏で働き続けないため）", async () => {
    const g = makeGroup(["transfer:data", "dtaq:entries"]);
    const w = mountNode(g);
    await nextTick();
    g.activeTab = "dtaq:entries";
    await nextTick();
    const panes = w.findAllComponents({ name: "TransferPane" });
    expect(panes).toHaveLength(1);
    expect(panes[0]!.props("active")).toBe(false);
    expect(w.findAllComponents({ name: "DtaqPane" })[0]!.props("active")).toBe(true);
    w.unmount();
  });

  it("5250 は従来どおりアクティブな 1 つだけ（画面の DOM が大きいので常時は持たない）", async () => {
    // セッション系タブ（接頭辞なし）はアプリ系の表に載らない＝包み紙を作らない
    const g = makeGroup(["sess-1", "transfer:data"]);
    const w = mountNode(g);
    await nextTick();
    expect(w.findAll(".pane-slot")).toHaveLength(0);
    g.activeTab = "transfer:data";
    await nextTick();
    expect(w.findAll(".pane-slot")).toHaveLength(1);
    w.unmount();
  });
});

/**
 * **メニューへ寄っても、別のシステムを選んでも残す**（利用者の追加指示）。
 *
 * `App.vue` はワークスペースを `v-if="!showLauncher"` で切っていた。メニュー（ランチャー）へ
 * 移るだけ、システムを選び直すだけで**タブのペインが丸ごとアンマウント**されていた
 * ——`showLauncher` は「明示的にメニューを開いた」ときだけでなく
 * **「選択中システムに見えるタブが無い」ときにも真**になるため、システム切替でも同じことが起きる。
 */
describe("メニュー・システム切替をまたいでも残す", () => {
  const SYS_A = { ref: "own:a", name: "A", host: "h", autoSignon: false };
  const SYS_B = { ref: "own:b", name: "B", host: "h", autoSignon: false };

  /**
   * **App をマウントしてからワークスペースを組む。**
   * `App.vue` は `<script setup>` の中で `workspaceStore.init()` を呼ぶ——setup は
   * インスタンス生成のたびに走るので、先に組むとマウントで消される（実際に踏んだ）。
   */
  async function setup() {
    systemsStore.systems = [SYS_A, SYS_B];
    systemsStore.sessions = [];
    systemsStore.loaded = true;
    systemsStore.select(SYS_A.ref);
    const w = mount(App);
    const g = workspaceStore.focusedGroup();
    g.tabs = ["transfer:data"];
    g.activeTab = "transfer:data";
    workspaceStore.tabSystem["transfer:data"] = SYS_A.ref;
    workspaceStore.showLauncher = false;
    await nextTick();
    return w;
  }

  it("**メニューへ寄って戻っても書いた内容が残る**", async () => {
    const w = await setup();
    const lib = () => w.find(".pane-slot[data-tab='transfer:data'] input");
    await lib().setValue("KEEPME");

    workspaceStore.showLauncher = true; // パンくずの「メニュー」
    await nextTick();
    expect(w.find(".pane-slot[data-tab='transfer:data']").exists(), "メニューで消えている").toBe(true);

    workspaceStore.showLauncher = false;
    await nextTick();
    expect((lib().element as HTMLInputElement).value).toBe("KEEPME");
    w.unmount();
  });

  it("**別のシステムを選んでも残る**（見えるタブが無くなってメニューが出る場面）", async () => {
    const w = await setup();
    const lib = () => w.find(".pane-slot[data-tab='transfer:data'] input");
    await lib().setValue("KEEPME");

    systemsStore.select(SYS_B.ref); // B に属するタブは無い＝ランチャーが出る
    await nextTick();
    expect(w.find(".pane-slot[data-tab='transfer:data']").exists(), "システム切替で消えている").toBe(true);

    systemsStore.select(SYS_A.ref);
    await nextTick();
    expect((lib().element as HTMLInputElement).value).toBe("KEEPME");
    w.unmount();
  });
});
