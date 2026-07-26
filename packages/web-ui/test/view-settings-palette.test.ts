import { describe, it, expect, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import ViewSettingsMenu from "../src/components/ViewSettingsMenu.vue";
import { viewSettings, initViewSettings, VIEW_ITEMS } from "../src/stores/viewSettings.js";
import { openHeaderMenu } from "../src/composables/headerMenu.js";

beforeEach(() => {
  localStorage.clear();
  initViewSettings();
  openHeaderMenu.value = null;
});

/** メニューを開いた状態でマウントする */
async function openMenu() {
  const w = mount(ViewSettingsMenu, { props: { sessionId: "s1" }, attachTo: document.body });
  await w.find("button.vsm-btn").trigger("click");
  await nextTick();
  return w;
}
/** ラベルで行を引く */
function row(w: Awaited<ReturnType<typeof openMenu>>, label: string) {
  return w.findAll(".vsm-row").find((r) => r.text().includes(label))!;
}

describe("設定名は対象を表す（FR-12）", () => {
  it("「入力項目設定」「ボタン設定」というラベルになっている", async () => {
    const w = await openMenu();
    const text = w.text();
    expect(text).toContain("入力項目設定");
    expect(text).toContain("ボタン設定");
    expect(text).not.toContain("コントロール表現");
    expect(text).not.toContain("ボタン意匠");
    w.unmount();
  });

  it("ボタンを使わない値は「無効」と表示される（「なし」ではない）", async () => {
    const w = await openMenu();
    const seg = row(w, "ボタン設定").find(".seg");
    expect(seg.text()).toContain("無効");
    w.unmount();
  });
});

describe("セグメントは「よく使う 3 つ ＋ その他」（FR-14）", () => {
  it("入力項目・ボタンとも 3 つ＋その他になっている", async () => {
    const w = await openMenu();
    for (const label of ["入力項目設定", "ボタン設定"]) {
      const btns = row(w, label).findAll(".seg button");
      expect(btns, label).toHaveLength(4);
      expect(btns[3]!.text(), label).toContain("その他");
    }
    w.unmount();
  });

  it("「枠」はセグメントに出さず、候補側にある", async () => {
    const w = await openMenu();
    expect(row(w, "入力項目設定").find(".seg").text()).not.toContain("枠");
    w.unmount();
  });
});

describe("その他からデザインを選ぶ（FR-13/14）", () => {
  it("その他を押すと候補一覧が開き、選ぶと即反映して閉じる", async () => {
    const w = await openMenu();
    expect(w.find(".vsm-palette").exists()).toBe(false);

    await row(w, "入力項目設定").find(".seg button.more").trigger("click");
    await nextTick();
    const pal = w.find(".vsm-palette");
    expect(pal.exists()).toBe(true);
    // 候補にはよく使う 3 つも含めて全部出す（現在値を確認できるように）
    expect(pal.findAll(".pal-item")).toHaveLength(VIEW_ITEMS.find((i) => i.key === "controls")!.opts.length);

    const dashed = pal.findAll(".pal-item").find((b) => b.text().includes("破線"))!;
    await dashed.trigger("click");
    await nextTick();

    expect(viewSettings.settings.controls).toBe("dashed"); // 即反映
    expect(w.find(".vsm-palette").exists()).toBe(false); // 閉じる
    w.unmount();
  });

  it("候補側のデザインを選んでいると「その他」が選択状態になる", async () => {
    viewSettings.set("controls", "dashed");
    const w = await openMenu();
    const more = row(w, "入力項目設定").find(".seg button.more");
    expect(more.classes()).toContain("on");
    // セグメントの通常の 3 つはどれも選択状態でない
    const quick = row(w, "入力項目設定").findAll(".seg button").slice(0, 3);
    expect(quick.every((b) => !b.classes().includes("on"))).toBe(true);
    w.unmount();
  });

  it("よく使う値を選んでいるときは「その他」は選択状態にならない", async () => {
    viewSettings.set("controls", "filled");
    const w = await openMenu();
    expect(row(w, "入力項目設定").find(".seg button.more").classes()).not.toContain("on");
    w.unmount();
  });

  it("候補一覧は同時に 1 つだけ開く", async () => {
    const w = await openMenu();
    await row(w, "入力項目設定").find(".seg button.more").trigger("click");
    await nextTick();
    await row(w, "ボタン設定").find(".seg button.more").trigger("click");
    await nextTick();
    expect(w.findAll(".vsm-palette")).toHaveLength(1);
    w.unmount();
  });
});

describe("旧値の移行（spec D8）", () => {
  it("保存済みの rich は box として読まれる（見た目は同じ「枠」）", () => {
    localStorage.setItem("as400.view.settings", JSON.stringify({ controls: "rich", buttons: "rich" }));
    initViewSettings();
    expect(viewSettings.settings.controls).toBe("box");
    expect(viewSettings.settings.buttons).toBe("box");
  });
});

describe("パレットの後始末（review R2）", () => {
  it("メニューを閉じるとパレットも畳まれ、開き直しは素の状態から", async () => {
    const w = await openMenu();
    await row(w, "ボタン設定").find(".seg button.more").trigger("click");
    await nextTick();
    expect(w.find(".vsm-palette").exists()).toBe(true);

    // 閉じる → 開き直す
    await w.find("button.vsm-btn").trigger("click");
    await nextTick();
    await w.find("button.vsm-btn").trigger("click");
    await nextTick();

    expect(w.find(".vsm-palette").exists()).toBe(false);
    w.unmount();
  });
});
