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
});

describe("畳んだ行（開く / 閉じる）", () => {
  it("初期状態では候補を 1 つも出さない", async () => {
    const w = await openMenu();
    expect(w.find(".vsm-palette").exists()).toBe(false);
    // 畳んだ 2 行にはセグメントを置かない
    for (const label of ["入力項目設定", "ボタン設定"]) {
      expect(row(w, label).find(".seg").exists(), label).toBe(false);
      expect(row(w, label).find(".vsm-toggle").text(), label).toBe("開く");
    }
    w.unmount();
  });

  it("「開く」で候補が展開し、ラベルが「閉じる」に変わる", async () => {
    const w = await openMenu();
    const r = row(w, "ボタン設定");
    await r.find(".vsm-toggle").trigger("click");
    await nextTick();

    expect(w.find(".vsm-palette").exists()).toBe(true);
    expect(w.findAll(".pal-item")).toHaveLength(VIEW_ITEMS.find((i) => i.key === "buttons")!.opts.length);
    expect(row(w, "ボタン設定").find(".vsm-toggle").text()).toBe("閉じる");
    w.unmount();
  });

  it("「閉じる」で畳まれる", async () => {
    const w = await openMenu();
    await row(w, "入力項目設定").find(".vsm-toggle").trigger("click");
    await nextTick();
    await row(w, "入力項目設定").find(".vsm-toggle").trigger("click");
    await nextTick();
    expect(w.find(".vsm-palette").exists()).toBe(false);
    w.unmount();
  });

  it("開けるのは同時に 1 行だけ", async () => {
    const w = await openMenu();
    await row(w, "入力項目設定").find(".vsm-toggle").trigger("click");
    await nextTick();
    await row(w, "ボタン設定").find(".vsm-toggle").trigger("click");
    await nextTick();
    expect(w.findAll(".vsm-palette")).toHaveLength(1);
    expect(row(w, "入力項目設定").find(".vsm-toggle").text()).toBe("開く");
    w.unmount();
  });
});

describe("候補から選ぶ（FR-13/14）", () => {
  it("選ぶと即反映し、**設定メニューもパレットも閉じない**", async () => {
    const w = await openMenu();
    await row(w, "入力項目設定").find(".vsm-toggle").trigger("click");
    await nextTick();

    const pick = async (name: string) => {
      await w.findAll(".pal-item").find((b) => b.text().includes(name))!.trigger("click");
      await nextTick();
    };
    await pick("破線");
    expect(viewSettings.settings.controls).toBe("dashed");
    // 見比べながら続けて試せるよう、開いたままにする
    expect(w.find(".vsm-menu").exists()).toBe(true);
    expect(w.find(".vsm-palette").exists()).toBe(true);

    await pick("発光");
    expect(viewSettings.settings.controls).toBe("glow");
    expect(w.find(".vsm-palette").exists()).toBe(true);
    w.unmount();
  });

  it("現在の値には印が付く", async () => {
    viewSettings.set("buttons", "pill");
    const w = await openMenu();
    await row(w, "ボタン設定").find(".vsm-toggle").trigger("click");
    await nextTick();
    const on = w.findAll(".pal-item").filter((b) => b.classes().includes("on"));
    expect(on).toHaveLength(1);
    expect(on[0]!.text()).toContain("ピル");
    w.unmount();
  });

  it("ボタンを使わない値は「無効」と表示される（「なし」ではない）", async () => {
    const w = await openMenu();
    await row(w, "ボタン設定").find(".vsm-toggle").trigger("click");
    await nextTick();
    expect(w.find(".vsm-palette").text()).toContain("無効");
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
    await row(w, "ボタン設定").find(".vsm-toggle").trigger("click");
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

describe("ウィンドウ設定はセクションで分かれる（ユーザー要求）", () => {
  it("1 つの行にまとまり、開くと「ウィンドウ」「背景」に分かれる", async () => {
    const w = await openMenu();
    // 行は 1 つ（ウィンドウ設定）
    const rows = w.findAll(".vsm-row").filter((r) => r.text().includes("ウィンドウ設定"));
    expect(rows).toHaveLength(1);

    await rows[0]!.find(".vsm-toggle").trigger("click");
    await nextTick();

    const sections = w.findAll(".vsm-section").map((d) => d.text());
    expect(sections).toEqual(["ウィンドウ", "背景"]);
    expect(w.findAll(".vsm-palette")).toHaveLength(2);
    w.unmount();
  });

  it("背景にはスモーク・すりガラス・ぼやけがある", async () => {
    const w = await openMenu();
    await w.findAll(".vsm-row").find((r) => r.text().includes("ウィンドウ設定"))!.find(".vsm-toggle").trigger("click");
    await nextTick();
    const back = w.findAll(".vsm-palette")[1]!.text();
    for (const name of ["無効", "スモーク", "すりガラス", "ぼやけ"]) expect(back).toContain(name);
    w.unmount();
  });

  it("ウィンドウと背景は別々に選べる", async () => {
    const w = await openMenu();
    await w.findAll(".vsm-row").find((r) => r.text().includes("ウィンドウ設定"))!.find(".vsm-toggle").trigger("click");
    await nextTick();
    const pals = w.findAll(".vsm-palette");
    await pals[0]!.findAll(".pal-item").find((b) => b.text().includes("浮き出し"))!.trigger("click");
    await pals[1]!.findAll(".pal-item").find((b) => b.text().includes("ぼやけ"))!.trigger("click");
    await nextTick();
    expect(viewSettings.settings.windowFrame).toBe("raised");
    expect(viewSettings.settings.windowBackdrop).toBe("blur");
    w.unmount();
  });
});
