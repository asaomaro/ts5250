import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import ViewSettingsMenu from "../src/components/ViewSettingsMenu.vue";
import { viewSettings, initViewSettings } from "../src/stores/viewSettings.js";
import { openHeaderMenu } from "../src/composables/headerMenu.js";

/**
 * 画面フォントの選択肢。**インストール済みフォントから選べる／未検出でも選択を塞がない**。
 *
 * 経緯: 選べるのが定義済み一覧だけで、しかも導入判定で `disabled` にしていたため、
 * フォントを入れても選べないことがあった（判定は canvas 実測・Local Font Access の許可に左右される）。
 */
type LocalFont = { family: string; fullName?: string };
function stubLocalFonts(fonts: LocalFont[] | null): void {
  if (fonts === null) {
    delete (globalThis as Record<string, unknown>).queryLocalFonts;
    return;
  }
  (globalThis as Record<string, unknown>).queryLocalFonts = () => Promise.resolve(fonts);
}

beforeEach(() => {
  localStorage.clear();
  initViewSettings();
  openHeaderMenu.value = null;
});
afterEach(() => stubLocalFonts(null));

/** メニューを開いた状態でマウントする（開く＝フォント判定が走る） */
async function openMenu() {
  const w = mount(ViewSettingsMenu, { props: { sessionId: "s1" }, attachTo: document.body });
  await w.find("button.vsm-btn").trigger("click");
  await nextTick();
  await nextTick(); // 判定は非同期（Local Font Access）
  await nextTick();
  return w;
}
const fontSelect = (w: Awaited<ReturnType<typeof openMenu>>) => w.find("select.vsm-select");

describe("画面フォントの選択肢", () => {
  it("推奨一覧は未検出でも選べる（disabled にしない）", async () => {
    const w = await openMenu();
    const disabled = fontSelect(w).findAll("option").filter((o) => o.attributes("disabled") !== undefined);
    expect(disabled, "選択を塞ぐ option があってはいけない").toHaveLength(0);
    w.unmount();
  });

  it("未検出の推奨フォントには印を出す（選べるが入っていないことは伝える）", async () => {
    stubLocalFonts([{ family: "Cica" }]); // Cica だけ入っている環境
    const w = await openMenu();
    const opt = (label: string) =>
      fontSelect(w).findAll("option").find((o) => o.text().startsWith(label))!;
    expect(opt("Cica").text(), "入っているものに印は付けない").not.toContain("（未検出）");
    expect(opt("白源 HackGen").text()).toContain("（未検出）");
    expect(opt("白源 HackGen").attributes("disabled"), "印を出すだけで選べる").toBeUndefined();
    w.unmount();
  });

  it("インストール済みフォントが一覧に出て、選ぶと設定に入る", async () => {
    stubLocalFonts([{ family: "Meiryo" }, { family: "Arial" }]);
    const w = await openMenu();
    const opts = fontSelect(w).findAll("option").map((o) => o.attributes("value"));
    expect(opts).toContain("Meiryo");
    await fontSelect(w).setValue("Meiryo");
    expect(viewSettings.settings.font).toBe("Meiryo");
    w.unmount();
  });

  it("一覧を出せないブラウザではその旨を出し、名前の直接入力で設定できる", async () => {
    const w = await openMenu();
    expect(w.text()).toContain("インストール済みフォントを一覧できません");
    await w.find("input.vsm-input").setValue("Migu 1M");
    await w.find(".vsm-fontname button").trigger("click");
    expect(viewSettings.settings.font).toBe("Migu 1M");
    w.unmount();
  });

  it("名前の直接入力は CSS を壊す文字を落としてから保存する", async () => {
    const w = await openMenu();
    await w.find("input.vsm-input").setValue('Meiryo"; background:red');
    await w.find(".vsm-fontname button").trigger("click");
    expect(viewSettings.settings.font).toBe("Meiryo backgroundred");
    w.unmount();
  });

  /** 一覧に無い値（別環境で選んだ・名前指定）でも選択状態が消えないこと。 */
  it("一覧に無い設定値は「指定中」として option に残る", async () => {
    viewSettings.set("font", "Meiryo" as never);
    const w = await openMenu();
    expect(fontSelect(w).findAll("optgroup").some((g) => g.attributes("label") === "指定中")).toBe(true);
    expect((fontSelect(w).element as HTMLSelectElement).value).toBe("Meiryo");
    w.unmount();
  });
});
