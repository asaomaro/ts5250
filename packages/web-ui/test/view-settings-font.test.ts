import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import ViewSettingsMenu from "../src/components/ViewSettingsMenu.vue";
import { viewSettings, initViewSettings } from "../src/stores/viewSettings.js";
import { openHeaderMenu } from "../src/composables/headerMenu.js";

/**
 * 画面フォントの選択肢＝**インストール済みフォント**。「推奨」の固定一覧は出さない。
 *
 * 経緯: 選べるのが定義済み一覧だけで、しかも導入判定で `disabled` にしていたため、
 * フォントを入れても選べないことがあった（判定は canvas 実測・Local Font Access の許可に左右される）。
 * 旧一覧の id は**過去の保存値を解決するためだけ**に残し、選択肢としては出さない。
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

/** メニューを開いた状態でマウントする（開く＝フォント一覧の取得が走る） */
async function openMenu() {
  const w = mount(ViewSettingsMenu, { props: { sessionId: "s1" }, attachTo: document.body });
  await w.find("button.vsm-btn").trigger("click");
  await nextTick();
  await nextTick(); // 一覧の取得は非同期（Local Font Access）
  await nextTick();
  return w;
}
const fontSelect = (w: Awaited<ReturnType<typeof openMenu>>) => w.find("select.vsm-select");
const groups = (w: Awaited<ReturnType<typeof openMenu>>) =>
  fontSelect(w).findAll("optgroup").map((g) => g.attributes("label"));

describe("画面フォントの選択肢", () => {
  it("「推奨」の固定一覧は出さない（標準とインストール済みだけ）", async () => {
    stubLocalFonts([{ family: "Meiryo" }]);
    const w = await openMenu();
    expect(fontSelect(w).text()).not.toContain("推奨");
    expect(fontSelect(w).text()).not.toContain("白源 HackGen");
    expect(fontSelect(w).text()).not.toContain("（未検出）");
    w.unmount();
  });

  it("選べないようにする option を作らない（導入判定で塞がない）", async () => {
    stubLocalFonts([{ family: "Meiryo" }]);
    const w = await openMenu();
    const disabled = fontSelect(w).findAll("option").filter((o) => o.attributes("disabled") !== undefined);
    expect(disabled).toHaveLength(0);
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

  it("「標準（自動）」は常に先頭に残る（既定スタックへ戻す道）", async () => {
    stubLocalFonts([{ family: "Meiryo" }]);
    const w = await openMenu();
    expect(fontSelect(w).findAll("option")[0]!.attributes("value")).toBe("system");
    w.unmount();
  });

  it("一覧を出せないブラウザではその旨を出し、名前の直接入力で設定できる", async () => {
    const w = await openMenu();
    expect(groups(w), "一覧が無ければ群も出さない").toEqual([]);
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

  /** 一覧に無い値（名前指定・別環境で選んだ）でも選択状態が消えないこと。 */
  it("一覧に無い設定値は「指定中」として option に残る", async () => {
    viewSettings.set("font", "Meiryo" as never);
    const w = await openMenu();
    expect(groups(w)).toContain("指定中");
    expect((fontSelect(w).element as HTMLSelectElement).value).toBe("Meiryo");
    w.unmount();
  });

  /** 一覧を廃止しても、以前「白源 HackGen」等を選んでいた人の設定は生かす。 */
  it("旧一覧の保存値は「指定中」にラベルで残る（id を生で見せない）", async () => {
    viewSettings.set("font", "hackgen" as never);
    const w = await openMenu();
    expect(fontSelect(w).text()).toContain("白源 HackGen");
    expect(fontSelect(w).text()).not.toContain("hackgen");
    expect((fontSelect(w).element as HTMLSelectElement).value).toBe("hackgen");
    w.unmount();
  });
});
