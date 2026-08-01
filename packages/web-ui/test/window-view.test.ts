import { describe, it, expect, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import ScreenGrid from "../src/components/ScreenGrid.vue";
import EmulatorPane from "../src/components/EmulatorPane.vue";
import { sessionsStore } from "../src/stores/sessions.js";
import { viewSettings, initViewSettings } from "../src/stores/viewSettings.js";
import type { Cell, ScreenSnapshot } from "@as400web/tn5250";
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
    gui: { selectionFields: [], windows: [{ id: 1, row: 6, col: 17, width: 46, height: 10, restrictCursor: false, pulldown: false }], scrollBars: [], gridLines: [] },
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
    // 宣言 row=6 col=17 46桁×10行。**宣言の位置は枠の左上**なので中身は 行 7 桁 20 から
    // → left 19ch / top 7.5em / 46ch × 12.5em
    const st = deco.attributes("style")!;
    expect(st).toContain("left: 19ch");
    expect(st).toContain("top: 7.5em");
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

/**
 * **窓の表示と、表示設定の枠が同じ場所を指しているか。**
 *
 * 窓まわりには位置を決める箇所が 3 つある。
 *   - `.gui-window`   … 拡張5250 の窓を示す枠（＝ホストの WDWBORDER が出る場所）
 *   - `.win-deco`     … 表示設定（windowFrame）の装飾枠
 *   - `.win-smoke`    … 窓の外を暗くする覆い（＝窓の中身の範囲の裏返し）
 *
 * ホストが送る位置は**枠の左上**で、中身はその 1 行下・3 桁右から始まる
 * （実機で確認。DDS の窓内定数が書かれた絶対位置が根拠）。
 * ここを取り違えると、装飾枠だけが実際の窓から斜めにずれる。
 * 実機 `TESTLIB/GRIDCL6`（枠指定の無い窓）で実際に起きていた。
 */
describe("窓の範囲と表示設定の枠の一致", () => {
  /** 実機 GRIDCL6 の窓: ホストは SBA(8,24)・深さ 8・幅 30 を送る */
  const WIN = { id: 1, row: 8, col: 24, width: 30, height: 8, restrictCursor: false, pulldown: false };
  const snap = (): ScreenSnapshot =>
    ({
      sessionId: "s", rows: 24, cols: 80, cursor: { row: 1, col: 1 }, keyboardLocked: false,
      cells: Array.from({ length: 24 }, () =>
        Array.from({ length: 80 }, () => ({ char: " ", kind: "sbcs", color: "green" }))
      ),
      fields: [],
      gui: { selectionFields: [], windows: [WIN], scrollBars: [], gridLines: [] }
    }) as unknown as ScreenSnapshot;

  const px = (style: string, key: string): string =>
    new RegExp(`${key}: ([^;]+);`).exec(style)?.[1] ?? "";

  it("枠の矩形（.gui-window）は行 8〜17・桁 25〜58 に出る", async () => {
    const w = mount(ScreenGrid, { props: { snapshot: snap(), edits: new Map(), focused: false } });
    await nextTick();
    const st = w.find(".gui-window").attributes("style")!;
    expect(px(st, "left")).toBe("24ch");   // 桁 25 の左端
    expect(px(st, "top")).toBe("8.75em");  // 行 8 の上端 (8-1)*1.25em
    expect(px(st, "width")).toBe("34ch");  // 幅 30 ＋ 左右の枠 4
    expect(px(st, "height")).toBe("12.5em"); // 高さ 8 ＋ 上下の枠 2
    w.unmount();
  });

  it("表示設定の枠（.win-deco）は窓の中身（行 9〜16・桁 27〜56）に重なる", async () => {
    const w = mount(ScreenGrid, {
      props: { snapshot: snap(), edits: new Map(), focused: false, windowFrame: "outline" }
    });
    await nextTick();
    const st = w.find(".win-deco").attributes("style")!;
    expect(px(st, "left")).toBe("26ch");   // 桁 27 の左端
    expect(px(st, "top")).toBe("10em");    // 行 9 の上端 (9-1)*1.25em
    expect(px(st, "width")).toBe("30ch");
    expect(px(st, "height")).toBe("10em"); // 8 行
    w.unmount();
  });

  it("装飾枠は枠の矩形の内側に収まる（斜めにずれない）", async () => {
    const w = mount(ScreenGrid, {
      props: { snapshot: snap(), edits: new Map(), focused: false, windowFrame: "outline" }
    });
    await nextTick();
    const num = (s: string): number => parseFloat(s);
    const win = w.find(".gui-window").attributes("style")!;
    const deco = w.find(".win-deco").attributes("style")!;
    expect(num(px(deco, "left"))).toBeGreaterThanOrEqual(num(px(win, "left")));
    expect(num(px(deco, "top"))).toBeGreaterThanOrEqual(num(px(win, "top")));
    expect(num(px(deco, "left")) + num(px(deco, "width")))
      .toBeLessThanOrEqual(num(px(win, "left")) + num(px(win, "width")));
    expect(num(px(deco, "top")) + num(px(deco, "height")))
      .toBeLessThanOrEqual(num(px(win, "top")) + num(px(win, "height")));
    w.unmount();
  });

  it("スモークの穴は装飾枠と同じ範囲（窓の中身）", async () => {
    const w = mount(ScreenGrid, {
      props: { snapshot: snap(), edits: new Map(), focused: false, windowFrame: "outline", windowBackdrop: "smoke" }
    });
    await nextTick();
    const smoke = w.findAll(".win-smoke").map((s) => s.attributes("style")!);
    // 上の覆いの下端＝穴の上端、左の覆いの右端＝穴の左端
    const top = smoke.find((s) => px(s, "top") === "0em")!;
    expect(parseFloat(px(top, "height"))).toBe(10); // 行 1〜8 = 8 行
    // 左の覆いは穴と同じ行範囲（top 10em）に並ぶ。上下の覆いは画面幅いっぱいなので区別する
    const left = smoke.find((s) => px(s, "left") === "0ch" && px(s, "top") === "10em")!;
    expect(parseFloat(px(left, "width"))).toBe(26); // 桁 1〜26
    w.unmount();
  });
});
