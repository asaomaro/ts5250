import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import { renderScreenHtml } from "@ts5250/tn5250/browser";
import type { ScreenSnapshot } from "@ts5250/tn5250";
import DesignMenu from "../src/components/DesignMenu.vue";
import { useSkin, initSkin, SKIN_META } from "../src/composables/useSkin.js";
import { openHeaderMenu } from "../src/composables/headerMenu.js";

/**
 * **「外観 > 5250 端末」はクラシック（ACS の標準色）とソフト（以前の既定）の 2 種。**
 *
 * 以前の既定は ACS より淡い色合いで、利用者の実画面と並べると違いが目立った（利用者の指摘）。
 * ACS の標準色（`ColorRemapModel5250` の既定。実画面の画素とも一致）を「クラシック」とし、
 * 以前の配色は「ソフト」として残す。
 */
const CANDIDATES = ["packages/web-ui/src", "src"];
const read = (rel: string): string => {
  for (const base of CANDIDATES) {
    try {
      return readFileSync(resolve(process.cwd(), base, rel), "utf8");
    } catch {
      /* もう片方の cwd を試す */
    }
  }
  throw new Error(`${rel} が見つからない`);
};
const css = read("styles.css").replace(/\/\*[\s\S]*?\*\//g, "");

/** 選択子（完全一致）の宣言を `名前 → 値` にする */
function vars(selector: string): Record<string, string> {
  const blocks = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  const hit = blocks.find((m) => m[1]!.trim() === selector);
  expect(hit, `${selector} の規則が無い`).toBeDefined();
  const out: Record<string, string> = {};
  for (const d of hit![2]!.split(";")) {
    const i = d.indexOf(":");
    if (i > 0) out[d.slice(0, i).trim()] = d.slice(i + 1).trim().toLowerCase();
  }
  return out;
}

const TERMINAL_KEYS = [
  "--crt", "--crt-bezel", "--crt-line",
  "--t-green", "--t-white", "--t-red", "--t-turquoise", "--t-yellow", "--t-pink", "--t-blue"
] as const;

const SOFT_SELECTOR = ':root[data-skin="t5250-soft"]:not([data-theme="light"])';

describe("端末の配色トークン", () => {
  it("クラシック（既定の :root）は ACS の標準色", () => {
    expect(vars(":root")).toMatchObject({
      "--crt": "#000000",
      "--t-green": "#00ff00",
      "--t-white": "#ffffff",
      "--t-red": "#ff0000",
      "--t-turquoise": "#00ffff",
      "--t-yellow": "#ffff00",
      "--t-pink": "#ff00ff",
      "--t-blue": "#7890f0" // ACS の CUSTOMBLUE = rgb(120,144,240)
    });
  });

  it("ソフトは以前の淡い配色で、ダークのときだけ差し替える", () => {
    expect(vars(SOFT_SELECTOR)).toMatchObject({
      "--crt": "#050d09",
      "--t-green": "#3ddc84",
      "--t-white": "#e8f0e8",
      "--t-blue": "#6ea8ff"
    });
  });

  it("ソフトは端末の 10 トークンを全部持つ（片方だけ淡い色が残らない）", () => {
    const soft = vars(SOFT_SELECTOR);
    for (const k of TERMINAL_KEYS) expect(soft[k], k).toBeDefined();
  });

  it("通常モード（ペーパー調）はクラシック・ソフト共通のまま", () => {
    expect(vars(':root[data-theme="light"]')).toMatchObject({ "--crt": "#f7f8f4", "--t-green": "#1a7f37" });
  });

  it("下線を文字色そのままにするのはクラシックのダークだけ（ACS と同じ）", () => {
    expect(vars(':root:not([data-skin]):not([data-theme="light"])')).toEqual({ "--t-underline": "100%" });
    // 読む側は 55%（以前の見え方）へ落ちる
    expect(css).toMatch(/\.a-underline \{ border-bottom: 1px solid color-mix\(in srgb, currentColor var\(--t-underline, 55%\), transparent\); \}/);
  });

  /**
   * **保存 HTML の配色と揃える**（対になる資産。片方だけ直る事故を機械で止める）。
   * HTML は外部 CSS を持てないので値を焼き込んでいる（tn5250 `screen-html.ts`）。
   */
  it("保存 HTML（クラシック / ソフト）の値が styles.css と一致する", () => {
    const snap = {
      sessionId: "s", rows: 24, cols: 80, cursor: { row: 1, col: 1 },
      keyboardLocked: false, cells: [], fields: []
    } as unknown as ScreenSnapshot;
    const block = (html: string, sel: RegExp): Record<string, string> => {
      const body = sel.exec(html)?.[1] ?? "";
      return Object.fromEntries(
        body.split(";").map((d) => d.split(":").map((x) => x.trim().toLowerCase()) as [string, string])
      );
    };
    const classic = block(renderScreenHtml(snap), /:root\{([^}]*)\}/);
    const soft = block(renderScreenHtml(snap, {}, { palette: "soft" }), /\.pal-soft\{([^}]*)\}/);
    const root = vars(":root");
    const softCss = vars(SOFT_SELECTOR);
    for (const k of TERMINAL_KEYS) {
      expect(classic[k], `classic ${k}`).toBe(root[k]);
      expect(soft[k], `soft ${k}`).toBe(softCss[k]);
    }
  });
});

describe("スキンの切り替え", () => {
  beforeEach(() => {
    localStorage.clear();
    initSkin();
    openHeaderMenu.value = null;
  });

  it("端末はクラシックとソフトの 2 つ（どちらも「5250 端末」）", () => {
    const terms = SKIN_META.filter((s) => s.group === "term");
    expect(terms.map((s) => [s.id, s.name, s.tag])).toEqual([
      ["t5250", "5250 端末", "クラシック"],
      ["t5250-soft", "5250 端末", "ソフト"]
    ]);
  });

  it("既定はクラシック（data-skin を付けない）", () => {
    expect(useSkin().skin.value).toBe("t5250");
    expect(document.documentElement.hasAttribute("data-skin")).toBe(false);
  });

  it("ソフトは data-skin を付け、保存して次回も開く", () => {
    const { setSkin } = useSkin();
    setSkin("t5250-soft");
    expect(document.documentElement.getAttribute("data-skin")).toBe("t5250-soft");
    initSkin();
    expect(useSkin().skin.value).toBe("t5250-soft");
    setSkin("t5250");
    expect(document.documentElement.hasAttribute("data-skin")).toBe(false);
  });

  it("以前の保存値 t5250 はクラシック（ACS の色）で開く", () => {
    localStorage.setItem("as400.skin", "t5250");
    initSkin();
    expect(useSkin().skin.value).toBe("t5250");
    expect(document.documentElement.hasAttribute("data-skin")).toBe(false);
  });

  async function openMenu() {
    const w = mount(DesignMenu, { attachTo: document.body });
    await w.find(".dz-btn").trigger("click");
    await nextTick();
    return w;
  }

  it("外観メニューに 2 つ並び、選ぶと切り替わる", async () => {
    const w = await openMenu();
    const terms = w.findAll(".dz-opt").filter((b) => b.text().includes("5250 端末"));
    expect(terms.map((b) => b.find(".tag").text())).toEqual(["クラシック", "ソフト"]);
    expect(terms[0]!.attributes("aria-checked")).toBe("true");
    await terms[1]!.trigger("click");
    expect(useSkin().skin.value).toBe("t5250-soft");
    expect(terms[1]!.attributes("aria-checked")).toBe("true");
    w.unmount();
  });

  it("表示モードはソフトでも出る（Web スキンでは出ない）", async () => {
    const { setSkin } = useSkin();
    setSkin("t5250-soft");
    let w = await openMenu();
    expect(w.text()).toContain("表示モード");
    w.unmount();
    openHeaderMenu.value = null;
    setSkin("github");
    w = await openMenu();
    expect(w.text()).not.toContain("表示モード");
    w.unmount();
    setSkin("t5250");
  });
});
