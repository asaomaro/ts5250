import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import ViewSettingsMenu from "../src/components/ViewSettingsMenu.vue";
import DesignMenu from "../src/components/DesignMenu.vue";
import PaneTabs from "../src/components/PaneTabs.vue";
import ReportText from "../src/components/ReportText.vue";
import { viewSettings, initViewSettings } from "../src/stores/viewSettings.js";
import { appearance, initAppearance } from "../src/stores/appearance.js";
import { workspaceStore } from "../src/stores/workspace.js";
import { systemsStore } from "../src/stores/systems.js";
import { makePaneTabId } from "../src/paneLabels.js";

/**
 * **表示設定の 2 段カスケード**（`20260802-appearance-and-view-cascade`）。
 *
 * `⚙ 画面` のボタンには「画面設定（このセッション）」と書いてあったが、
 * `effective(_sessionId)` は引数を使っておらず**全画面共通の値を返していた**
 * ——セッションごとの設定は 1 つも無かった。ここで名実を合わせる。
 *
 * 守るのは 4 点:
 *
 * 1. 既定を変えると**上書きしていないセッションすべて**に効く
 * 2. 個別指定したセッションは**追従しない**。`既定に従う` へ戻せば再び追従する
 * 3. **移行で見え方が変わらない**（既存の保存値は既定として読む・上書きは空で始まる）
 * 4. メニューの初期の層は `全体の既定`（従来の使い勝手を黙って変えない）
 */

const S1 = "sess-1";
const S2 = "sess-2";

beforeEach(() => {
  localStorage.clear();
  initViewSettings();
  initAppearance();
});
afterEach(() => {
  viewSettings.clearAll(S1);
  viewSettings.clearAll(S2);
  localStorage.clear();
});

describe("カスケード", () => {
  it("**既定は上書きしていないセッション全部に効く**", () => {
    viewSettings.set("sosi", true);
    expect(viewSettings.effective(S1).sosi).toBe(true);
    expect(viewSettings.effective(S2).sosi).toBe(true);
  });

  it("**個別指定はそのセッションだけ**（他は既定のまま）", () => {
    viewSettings.setOverride(S1, "sosi", true);
    expect(viewSettings.effective(S1).sosi).toBe(true);
    expect(viewSettings.effective(S2).sosi, "隣のセッションまで変わっている").toBe(false);
    expect(viewSettings.settings.sosi, "既定まで書き換えている").toBe(false);
  });

  it("**個別指定したら既定の変更に追従しない**", () => {
    viewSettings.setOverride(S1, "surface", "crt");
    viewSettings.set("surface", "flat");
    expect(viewSettings.effective(S1).surface).toBe("crt");
    expect(viewSettings.effective(S2).surface).toBe("flat");
  });

  it("`既定に従う` へ戻すと再び追従する", () => {
    viewSettings.setOverride(S1, "surface", "crt");
    viewSettings.clearOverride(S1, "surface");
    expect(viewSettings.isOverridden(S1, "surface")).toBe(false);
    viewSettings.set("surface", "crt");
    expect(viewSettings.effective(S1).surface).toBe("crt");
    viewSettings.set("surface", "flat");
    expect(viewSettings.effective(S1).surface, "追従が戻っていない").toBe("flat");
  });

  it("すべて既定に戻すと、そのセッションの上書きが全部消える", () => {
    viewSettings.setOverride(S1, "sosi", true);
    viewSettings.setOverride(S1, "surface", "crt");
    expect(viewSettings.hasOverrides(S1)).toBe(true);
    viewSettings.clearAll(S1);
    expect(viewSettings.hasOverrides(S1)).toBe(false);
    expect(viewSettings.effective(S1).sosi).toBe(false);
  });

  it("`set` は既定を書く（キー設定からの順送りはアプリ全体の操作）", () => {
    viewSettings.setOverride(S1, "sosi", true);
    viewSettings.cycle("sosi");
    expect(viewSettings.settings.sosi, "既定が動いていない").toBe(true);
    expect(viewSettings.effective(S1).sosi, "上書きが既定に食われている").toBe(true);
  });
});

describe("移行", () => {
  it("**既存の保存値は既定として読む／上書きは空で始まる**（見え方が変わらない）", () => {
    localStorage.setItem("as400.view.settings", JSON.stringify({ sosi: true, surface: "crt" }));
    initViewSettings();
    expect(viewSettings.settings.sosi).toBe(true);
    expect(viewSettings.settings.surface).toBe("crt");
    // どのセッションから見ても同じ＝移行前と同じ見え方
    expect(viewSettings.effective(S1)).toEqual(viewSettings.settings);
    expect(viewSettings.hasOverrides(S1)).toBe(false);
  });
});

describe("表示メニュー", () => {
  const mountMenu = () => mount(ViewSettingsMenu, { props: { sessionId: S1 }, attachTo: document.body });
  /**
   * **開くまで押す。** ヘッダーのポップオーバーの開閉状態はモジュール共有なので、
   * 前のテストが開いたまま終わると、次の 1 回目のクリックが「閉じる」になる（実際に踏んだ）。
   */
  async function openMenu(w: ReturnType<typeof mountMenu>) {
    for (let i = 0; i < 2 && !w.find(".vsm-menu").exists(); i++) {
      await w.find(".vsm-btn").trigger("click");
      await nextTick();
    }
    expect(w.find(".vsm-menu").exists(), "メニューが開かない").toBe(true);
    return w;
  }
  const row = (w: ReturnType<typeof mountMenu>, label: string) =>
    w.findAll(".vsm-row").find((r) => r.find(".vsm-label").exists() && r.find(".vsm-label").text().startsWith(label))!;

  it("ボタンは `⚙ 表示`（対象の広さが名前で分かる）", () => {
    const w = mountMenu();
    expect(w.find(".vsm-btn").text()).toBe("⚙ 表示");
    w.unmount();
  });

  it("**初期の層は「全体の既定」**（従来の使い勝手を黙って変えない）", async () => {
    const w = await openMenu(mountMenu());
    const seg = row(w, "設定の対象").findAll(".seg button");
    expect(seg.find((b) => b.text() === "全体の既定")!.classes()).toContain("on");
    // その層で変えると既定が動く
    await row(w, "SO/SI 表示").findAll(".seg button").find((b) => b.text() === "表示")!.trigger("click");
    expect(viewSettings.settings.sosi).toBe(true);
    expect(viewSettings.hasOverrides(S1), "既定層なのに上書きを作っている").toBe(false);
    w.unmount();
  });

  it("**このセッション層では上書きになり、既定は動かない**", async () => {
    const w = await openMenu(mountMenu());
    await row(w, "設定の対象").findAll(".seg button").find((b) => b.text() === "このセッション")!.trigger("click");
    await row(w, "SO/SI 表示").findAll(".seg button").find((b) => b.text() === "表示")!.trigger("click");
    expect(viewSettings.isOverridden(S1, "sosi")).toBe(true);
    expect(viewSettings.settings.sosi, "既定まで動いている").toBe(false);
    w.unmount();
  });

  /**
   * **「既定に従う」の選択肢は置かない**（`20260802-view-menu-refine`・利用者の指摘）。
   * 値の一覧に小さな印を添えるだけにして、選択肢が 1 つ増えるのを避ける。
   */
  it("**選択肢は値だけ／既定に印が付く**", async () => {
    viewSettings.set("surface", "crt");
    const w = await openMenu(mountMenu());
    await row(w, "設定の対象").findAll(".seg button").find((b) => b.text() === "このセッション")!.trigger("click");
    const btns = row(w, "画面の質感").findAll(".seg button");
    expect(btns.some((b) => b.text().includes("既定に従う")), "「既定に従う」が残っている").toBe(false);
    const crt = btns.find((b) => b.text().startsWith("CRT"))!;
    expect(crt.find(".vsm-def").exists(), "既定の印が付いていない").toBe(true);
    expect(crt.classes(), "継承中は既定の値が選択状態に見えるはず").toContain("on");
    w.unmount();
  });

  /**
   * **既定と同じ値を選んだら追従に戻す。** これが無いと、一度個別指定したら
   * 二度と既定の変更に追従できなくなる（`すべて既定に戻す` しか手が無くなる）。
   */
  it("**既定と同じ値を選ぶと上書きが消える**（追従に戻る）", async () => {
    const w = await openMenu(mountMenu());
    await row(w, "設定の対象").findAll(".seg button").find((b) => b.text() === "このセッション")!.trigger("click");
    await row(w, "画面の質感").findAll(".seg button").find((b) => b.text().startsWith("CRT"))!.trigger("click");
    expect(viewSettings.isOverridden(S1, "surface")).toBe(true);

    // 既定（フラット）を押す＝追従へ戻る
    await row(w, "画面の質感").findAll(".seg button").find((b) => b.text().startsWith("フラット"))!.trigger("click");
    expect(viewSettings.isOverridden(S1, "surface"), "上書きが残っている").toBe(false);
    w.unmount();
  });

  it("**`keys` で項目を絞れる**（帳票の画面では効くものだけ出す）", async () => {
    const w = mount(ViewSettingsMenu, {
      props: { sessionId: S1, keys: ["linkify", "font"] },
      attachTo: document.body
    });
    await openMenu(w);
    const labels = w.findAll(".vsm-label").map((l) => l.text());
    expect(labels).toContain("リンク化");
    expect(labels).toContain("フォント（画面）");
    expect(labels, "5250 画面専用の項目まで出ている").not.toContain("SO/SI 表示");
    w.unmount();
  });

  it("表示設定に `theme` はもう無い（外観の一本立てに戻した）", () => {
    expect(Object.keys(viewSettings.settings)).not.toContain("theme");
  });

  it("個別指定した項目に印が出て、すべて既定に戻すで消える", async () => {
    const w = await openMenu(mountMenu());
    await row(w, "設定の対象").findAll(".seg button").find((b) => b.text() === "このセッション")!.trigger("click");
    await row(w, "SO/SI 表示").findAll(".seg button").find((b) => b.text() === "表示")!.trigger("click");
    await nextTick();
    expect(row(w, "SO/SI 表示").find(".vsm-mark").exists()).toBe(true);

    await w.findAll(".vsm-toggle").find((b) => b.text().includes("すべて既定に戻す"))!.trigger("click");
    await nextTick();
    expect(viewSettings.hasOverrides(S1)).toBe(false);
    w.unmount();
  });
});

describe("外観メニュー", () => {
  it("ボタンは `外観`（スキン名ではない＝ヘッダーが短くなる）", () => {
    const w = mount(DesignMenu, { attachTo: document.body });
    expect(w.find(".dz-btn").text()).toBe("外観");
    w.unmount();
  });

  it("タブにシステム名を出すトグルがある（既定 ON）", async () => {
    const w = mount(DesignMenu, { attachTo: document.body });
    for (let i = 0; i < 2 && !w.find(".dz-menu").exists(); i++) {
      await w.find(".dz-btn").trigger("click");
      await nextTick();
    }
    const box = w.find(".dz-toggle input");
    expect((box.element as HTMLInputElement).checked).toBe(true);
    await box.setValue(false);
    expect(appearance.value.showTabSystemName).toBe(false);
    w.unmount();
  });
});

describe("タブのシステム名トグル", () => {
  const A = { ref: "own:a", name: "エー", host: "h", autoSignon: false };
  const B = { ref: "own:b", name: "ビー", host: "h", autoSignon: false };

  function twoSystems() {
    systemsStore.systems = [A, B];
    systemsStore.loaded = true;
    workspaceStore.init();
    const g = workspaceStore.focusedGroup();
    g.tabs = [makePaneTabId("sql:query", A.ref), makePaneTabId("sql:query", B.ref)];
    g.activeTab = g.tabs[0];
    return g;
  }

  it("ON なら 2 システムで名前が出る", () => {
    const g = twoSystems();
    const w = mount(PaneTabs, { props: { group: g } });
    expect(w.findAll(".sysname").length).toBe(2);
    w.unmount();
  });

  it("**OFF なら 2 システムでも名前が出ない。ただし色帯は残る**", () => {
    const g = twoSystems();
    appearance.set("showTabSystemName", false);
    const w = mount(PaneTabs, { props: { group: g } });
    expect(w.findAll(".sysname").length).toBe(0);
    expect(w.find(".tab").attributes("style") ?? "", "色帯まで消している").toContain("--tab-sys");
    w.unmount();
  });
});

/**
 * **帳票の画面の「表示」**（`20260802-view-menu-refine`・利用者の指示）。
 *
 * プリンターセッションとスプールでも `⚙ 表示` を出す。ただし項目は
 * **その経路で実際に効くもの**だけ——帳票の本文は SCS の復号を通った Unicode 文字列で
 * 届き、SO/SI は復号時に消費されるので、SO/SI 表示と表示コードは実装できない。
 */
describe("帳票の画面の表示設定", () => {
  it("**リンク化が効く**（URL が `<a>` になる）", () => {
    const w = mount(ReportText, {
      props: { sessionId: "p1", text: "詳細は https://example.com/x を参照\n次の行" }
    });
    const a = w.find("a");
    expect(a.exists()).toBe(true);
    expect(a.text()).toContain("example.com");
    expect(w.text(), "本文が失われている").toContain("次の行");
    w.unmount();
  });

  it("リンク化を切ると素のまま出る", () => {
    viewSettings.setOverride("p1", "linkify", false);
    const w = mount(ReportText, { props: { sessionId: "p1", text: "https://example.com/x" } });
    expect(w.find("a").exists()).toBe(false);
    expect(w.text()).toContain("https://example.com/x");
    w.unmount();
    viewSettings.clearAll("p1");
  });

  it("**改行をまたいでリンクにしない**（行ごとに探す）", () => {
    const w = mount(ReportText, { props: { sessionId: "p1", text: "https://example.com\n/x" } });
    expect(w.findAll("a")).toHaveLength(1);
    expect(w.find("a").text()).toBe("https://example.com");
    w.unmount();
  });
});
