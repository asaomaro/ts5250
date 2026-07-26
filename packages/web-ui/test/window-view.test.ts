import { describe, it, expect, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import ScreenGrid from "../src/components/ScreenGrid.vue";
import EmulatorPane from "../src/components/EmulatorPane.vue";
import { sessionsStore } from "../src/stores/sessions.js";
import { viewSettings, initViewSettings } from "../src/stores/viewSettings.js";
import type { Cell, ScreenSnapshot } from "@as400web/core";
import type { WsClient } from "../src/ws-client.js";

const SID = "wv1";
function cell(ch: string, kind: Cell["kind"] = "sbcs"): Cell {
  return { char: ch, kind, color: "green", reverse: false, underline: false, blink: false, columnSeparator: false, nonDisplay: false };
}
function toCells(line: string, cols = 80): Cell[] {
  const out: Cell[] = [];
  for (const ch of line) {
    if (/[⺀-꓏가-힣豈-﫿＀-｠]/.test(ch)) { out.push(cell(ch, "dbcs-lead")); out.push(cell(" ", "dbcs-tail")); }
    else out.push(cell(ch));
  }
  while (out.length < cols) out.push(cell(" "));
  return out.slice(0, cols);
}
function snapOf(lines: string[], extra: Partial<ScreenSnapshot> = {}): ScreenSnapshot {
  const cells: Cell[][] = [];
  for (let r = 0; r < 24; r++) cells.push(toCells(lines[r] ?? "", 80));
  return { sessionId: SID, rows: 24, cols: 80, cursor: { row: 1, col: 1 }, keyboardLocked: false, cells, fields: [], ...extra } as ScreenSnapshot;
}

/** 文字で描かれた窓（F1 ヘルプ相当。上下 `.`・左右 `:`） */
const CHAR_WINDOW = (() => {
  const l = Array(24).fill("");
  l[5] = " ".repeat(15) + ".".repeat(50);
  for (let r = 6; r <= 20; r++) l[r] = " ".repeat(15) + ":" + " ".repeat(48) + ":";
  l[21] = " ".repeat(15) + ".".repeat(50);
  l[0] = " 下の画面";
  return l;
})();

/** 拡張5250 の窓（アプリの WINDOW DSPF 相当） */
const guiWindowSnap = () =>
  snapOf([" 下の画面"], {
    gui: { selectionFields: [], windows: [{ id: 1, row: 6, col: 17, width: 46, height: 10, restrictCursor: false, pulldown: false }], scrollBars: [] },
  } as Partial<ScreenSnapshot>);

beforeEach(() => {
  localStorage.clear();
  initViewSettings();
});

describe("既定（無効）では何も重ねない", () => {
  it("窓があっても要素を 1 つも出さない", async () => {
    const w = mount(ScreenGrid, { props: { snapshot: snapOf(CHAR_WINDOW), edits: new Map(), focused: false } });
    await nextTick();
    expect(w.findAll(".win-deco")).toHaveLength(0);
    expect(w.findAll(".win-smoke")).toHaveLength(0);
    w.unmount();
  });
});

describe("両方の種類の窓に効く（FR-4）", () => {
  it("文字で描かれた窓（ヘルプ等）で装飾が出る", async () => {
    const w = mount(ScreenGrid, { props: { snapshot: snapOf(CHAR_WINDOW), edits: new Map(), focused: false, windowFrame: "shadow", windowBackdrop: "smoke" } });
    await nextTick();
    expect(w.findAll(".win-deco")).toHaveLength(1);
    expect(w.findAll(".win-smoke").length).toBeGreaterThan(0);
    w.unmount();
  });

  it("拡張5250 の窓（アプリの WINDOW DSPF）で装飾が出て、位置が宣言と一致する", async () => {
    const w = mount(ScreenGrid, { props: { snapshot: guiWindowSnap(), edits: new Map(), focused: false, windowFrame: "shadow" } });
    await nextTick();
    const deco = w.find(".win-deco");
    expect(deco.exists()).toBe(true);
    // 宣言 row=6 col=17 46桁×10行 → left 16ch / top 6.25em / 46ch × 12.5em
    const st = deco.attributes("style")!;
    expect(st).toContain("left: 16ch");
    expect(st).toContain("top: 6.25em");
    expect(st).toContain("width: 46ch");
    expect(st).toContain("height: 12.5em");
    w.unmount();
  });

  it("窓が無い画面では何も出ない", async () => {
    const w = mount(ScreenGrid, { props: { snapshot: snapOf([" ふつうの画面"]), edits: new Map(), focused: false, windowFrame: "shadow", windowBackdrop: "smoke" } });
    await nextTick();
    expect(w.findAll(".win-deco")).toHaveLength(0);
    expect(w.findAll(".win-smoke")).toHaveLength(0);
    w.unmount();
  });
});

describe("スモークは窓の外だけを覆う（spec D3）", () => {
  it("窓の中を覆う矩形が無い", async () => {
    const w = mount(ScreenGrid, { props: { snapshot: guiWindowSnap(), edits: new Map(), focused: false, windowBackdrop: "smoke" } });
    await nextTick();
    // 窓: 行 6〜15 / 桁 17〜62 → 上・下・左・右 の 4 枚
    const rects = w.findAll(".win-smoke").map((d) => d.attributes("style")!);
    expect(rects).toHaveLength(4);
    // どの矩形も窓の内側（left>=16ch かつ top>=6.25em の領域）を完全には覆わない
    const inner = rects.filter((s) => /left: 16ch/.test(s) && /top: 6.25em/.test(s) && /width: 46ch/.test(s));
    expect(inner).toHaveLength(0);
    w.unmount();
  });
});

describe("桁と操作を壊さない（FR-5/FR-6）", () => {
  it("装飾の ON/OFF で行のテキストが変わらない", async () => {
    const snap = snapOf(CHAR_WINDOW);
    const off = mount(ScreenGrid, { props: { snapshot: snap, edits: new Map(), focused: false } });
    const on = mount(ScreenGrid, { props: { snapshot: snap, edits: new Map(), focused: false, windowFrame: "raised" } });
    await nextTick();
    const rows = (w: ReturnType<typeof mount>) => w.findAll(".grid-row").map((r) => r.text()).join("\n");
    expect(rows(on)).toBe(rows(off));
    off.unmount();
    on.unmount();
  });

  it("ペインに data-window が伝わる", async () => {
    sessionsStore.byId.clear();
    sessionsStore.order = [];
    sessionsStore.add({
      sessionId: SID, label: "t", snapshot: snapOf(CHAR_WINDOW), edits: new Map(), cursor: { row: 1, col: 1 },
      connected: true, readOnly: false, client: { send() {} } as unknown as WsClient,
    });
    viewSettings.set("windowFrame", "outline");
    const w = mount(EmulatorPane, { props: { sessionId: SID, focused: true }, attachTo: document.body });
    await nextTick();
    expect(w.find(".pane").attributes("data-window-frame")).toBe("outline");
    expect(w.findAll(".win-deco")).toHaveLength(1);
    w.unmount();
  });
});

describe("CSS 契約（ビルド後）", () => {
  it("装飾は操作を透過し、意匠が定義されている", async () => {
    const { existsSync, readdirSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const dir = join(process.cwd(), "dist/assets");
    if (!existsSync(dir)) return;
    const css = readdirSync(dir).filter((f) => f.endsWith(".css")).map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
    if (!css) return;
    // 重ねた要素が操作を奪わないこと（これが無いと窓の中がクリックできなくなる）
    const base = /\.win-smoke\[data-v-[a-z0-9]+\],\.win-deco\[data-v-[a-z0-9]+\]\{([^}]*)\}/.exec(css);
    expect(base, ".win-smoke/.win-deco の基本ルールが見つからない").not.toBeNull();
    expect(base![1]).toContain("pointer-events:none");
    for (const style of ["shadow", "raised", "outline"]) {
      expect(css, `ウィンドウ本体 ${style} の意匠が無い`).toContain(`[data-window-frame=${style}]`);
    }
    for (const style of ["smoke", "frost", "blur"]) {
      expect(css, `背景 ${style} の意匠が無い`).toContain(`[data-window-backdrop=${style}]`);
    }
    // すりガラス・ぼやけは backdrop-filter で下の画面をぼかす
    expect(css).toMatch(/\[data-window-backdrop=(frost|blur)\][^{]*\{[^}]*backdrop-filter/);
  });
});

describe("ウィンドウと背景は独立した設定（ユーザー要求）", () => {
  it("背景だけ指定すると枠は出ず、背景だけ出る", async () => {
    const w = mount(ScreenGrid, { props: { snapshot: guiWindowSnap(), edits: new Map(), focused: false, windowBackdrop: "frost" } });
    await nextTick();
    expect(w.findAll(".win-deco")).toHaveLength(0);
    expect(w.findAll(".win-smoke")).toHaveLength(4);
    w.unmount();
  });

  it("ウィンドウだけ指定すると背景は出ず、枠だけ出る", async () => {
    const w = mount(ScreenGrid, { props: { snapshot: guiWindowSnap(), edits: new Map(), focused: false, windowFrame: "raised" } });
    await nextTick();
    expect(w.findAll(".win-deco")).toHaveLength(1);
    expect(w.findAll(".win-smoke")).toHaveLength(0);
    w.unmount();
  });

  it("旧 windowView の保存値は 2 項目へ読み替えられる", () => {
    localStorage.setItem("as400.view.settings", JSON.stringify({ windowView: "smokeShadow" }));
    initViewSettings();
    expect(viewSettings.settings.windowFrame).toBe("shadow");
    expect(viewSettings.settings.windowBackdrop).toBe("smoke");
  });
});
