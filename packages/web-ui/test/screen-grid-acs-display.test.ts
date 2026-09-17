import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import ScreenGrid from "../src/components/ScreenGrid.vue";
import type { ScreenSnapshot, Cell, Field } from "@ts5250/tn5250";

/**
 * **ACS の「表示」設定（カーソル・罫線）を画面に効かせる。**
 *
 * 値と描き方は ACS の実装で確かめた（`ScreenText` / `DisplayUI`、ヘルプ display_setup.html）:
 *   - カーソル: 形状＝下線／ブロック（白の XOR）、挿入モード中は下半分、明滅は 0.5 秒ごと
 *   - 罫線: カーソルの行の下端に横線・桁の左端に縦線。「カーソルに従う＝いいえ」は出した時点の
 *     位置に固定。フォーカスが外れても消えない
 */
function cell(char = " "): Cell {
  return {
    char, kind: "sbcs", color: "green", reverse: false, underline: false,
    blink: false, columnSeparator: false, nonDisplay: false
  };
}

function snap(
  fields: Field[] = [],
  size: Pick<ScreenSnapshot, "rows" | "cols"> = { rows: 24, cols: 80 }
): ScreenSnapshot {
  const cells: Cell[][] = [];
  for (let r = 0; r < size.rows; r++) cells.push(Array.from({ length: size.cols }, () => cell()));
  return { sessionId: "s", ...size, cursor: { row: 5, col: 10 }, keyboardLocked: false, cells, fields };
}

const FIELD: Field = {
  index: 1, row: 20, col: 8, length: 20, protected: false, hidden: false, numeric: false, mdt: false, value: ""
};

type Props = InstanceType<typeof ScreenGrid>["$props"];
function grid(props: Partial<Props> = {}, snapshot = snap()) {
  return mount(ScreenGrid, {
    props: { snapshot, edits: new Map(), focused: true, ...props },
    attachTo: document.body
  });
}
const style = (w: ReturnType<typeof grid>, sel: string) => w.find(sel).attributes("style") ?? "";

describe("カーソルの形状と明滅", () => {
  it("既定はブロックで、フォーカス中は明滅する", () => {
    const w = grid();
    const c = w.find(".cursor");
    expect(c.classes()).toContain("shape-block");
    expect(c.classes()).toContain("live");
    w.unmount();
  });

  it("下線にできる", () => {
    const w = grid({ cursorShape: "underline" });
    expect(w.find(".cursor").classes()).toContain("shape-underline");
    w.unmount();
  });

  it("明滅を切れる（切ってもカーソルは出る）", () => {
    const w = grid({ cursorBlink: false });
    expect(w.find(".cursor").exists()).toBe(true);
    expect(w.find(".cursor").classes()).not.toContain("live");
    w.unmount();
  });

  it("フォーカスの無いペインでは明滅しない", () => {
    const w = grid({ focused: false });
    expect(w.find(".cursor").classes()).not.toContain("live");
    w.unmount();
  });

  it("挿入モード中は形状に依らず下半分（ACS `setInsert`）", async () => {
    const w = grid({ cursorShape: "underline", insertMode: true });
    expect(w.find(".cursor").classes()).toContain("ins");
    await w.setProps({ insertMode: false });
    expect(w.find(".cursor").classes()).not.toContain("ins");
    w.unmount();
  });

  it("動くたびに要素を作り直す（明滅を頭からやり直し、移動直後は必ず見える）", async () => {
    const w = grid({ cursor: { row: 5, col: 10 } });
    const before = w.find(".cursor").element;
    await w.setProps({ cursor: { row: 5, col: 11 } });
    expect(w.find(".cursor").element).not.toBe(before);
    expect(style(w, ".cursor")).toContain("left: 10ch");
    w.unmount();
  });

  it("IME の変換中はカーソルを隠し、確定したら戻す（変換中の字にかぶるため）", async () => {
    const w = grid({}, snap([FIELD]));
    const input = w.find("input.grid-input");
    (input.element as HTMLInputElement).focus();
    await input.trigger("compositionstart");
    expect(w.find(".cursor").exists()).toBe(false);
    expect(w.find(".grid").attributes("data-composing")).toBe("true");
    await input.trigger("compositionend");
    expect(w.find(".cursor").exists()).toBe(true);
    expect(w.find(".grid").attributes("data-composing")).toBe("false");
    w.unmount();
  });

  it("DBCS 欄では、キャレットの下の全角 1 文字ぶん（2 桁）を覆う", async () => {
    const dbcs: Field = { ...FIELD, row: 2, col: 3, dbcsType: "open" };
    const w = mount(ScreenGrid, {
      props: { snapshot: snap([dbcs]), edits: new Map([[1, "あいう"]]), focused: true },
      attachTo: document.body
    });
    (w.find("input.grid-input").element as HTMLInputElement).focus();
    await nextTick();
    // 欄 3 桁目は SO、「あ」は 4〜5 桁目 → left 3ch / 幅 2ch
    expect(style(w, ".cursor")).toContain("left: 3ch");
    expect(style(w, ".cursor")).toContain("width: 2ch");
    w.unmount();
  });
});

describe("罫線", () => {
  it("既定では出さない", () => {
    const w = grid();
    expect(w.find(".rule").exists()).toBe(false);
    w.unmount();
  });

  it("十字線: カーソルの桁の左端に縦線、行の下端に横線（画面の端から端まで）", () => {
    const w = grid({ ruleLine: true, cursor: { row: 5, col: 10 } });
    expect(style(w, ".rule-v")).toContain("left: 9ch");
    expect(style(w, ".rule-v")).toContain("height: 30em"); // 24 行 × 1.25em
    expect(style(w, ".rule-h")).toContain("top: 6.25em"); // 5 行目の下端
    expect(style(w, ".rule-h")).toContain("width: 80ch");
    w.unmount();
  });

  it("水平は横線だけ、垂直は縦線だけ", async () => {
    const w = grid({ ruleLine: true, ruleStyle: "horizontal" });
    expect(w.find(".rule-h").exists()).toBe(true);
    expect(w.find(".rule-v").exists()).toBe(false);
    await w.setProps({ ruleStyle: "vertical" });
    expect(w.find(".rule-h").exists()).toBe(false);
    expect(w.find(".rule-v").exists()).toBe(true);
    w.unmount();
  });

  it("カーソルに従う（既定）: カーソルと一緒に動く", async () => {
    const w = grid({ ruleLine: true, cursor: { row: 5, col: 10 } });
    await w.setProps({ cursor: { row: 8, col: 20 } });
    expect(style(w, ".rule-v")).toContain("left: 19ch");
    expect(style(w, ".rule-h")).toContain("top: 10em");
    w.unmount();
  });

  it("入力欄の中ではキャレットの桁に引く（カーソルと同じ位置）", async () => {
    const w = grid({ ruleLine: true }, snap([FIELD]));
    (w.find("input.grid-input").element as HTMLInputElement).focus();
    await nextTick();
    expect(style(w, ".rule-v")).toContain("left: 7ch");
    expect(style(w, ".rule-h")).toContain("top: 25em"); // 20 行目の下端
    w.unmount();
  });

  it("従わない: 出した時点の位置に固定し、カーソルが動いても残る", async () => {
    const w = grid({ ruleLine: false, ruleFollow: false, cursor: { row: 5, col: 10 } });
    await w.setProps({ cursor: { row: 6, col: 12 } });
    await w.setProps({ ruleLine: true }); // ここで固める＝(6,12)
    await w.setProps({ cursor: { row: 9, col: 30 } });
    expect(style(w, ".rule-v")).toContain("left: 11ch");
    expect(style(w, ".rule-h")).toContain("top: 7.5em");
    // 出し直しても位置は保つ（ACS は固定位置を設定に残す）
    await w.setProps({ ruleLine: false });
    await w.setProps({ ruleLine: true });
    expect(style(w, ".rule-v")).toContain("left: 11ch");
    w.unmount();
  });

  it("従うに戻すとカーソルへ追従し、また従わないにするとその時点で固め直す", async () => {
    const w = grid({ ruleLine: true, ruleFollow: false, cursor: { row: 5, col: 10 } });
    await w.setProps({ ruleFollow: true, cursor: { row: 7, col: 3 } });
    expect(style(w, ".rule-v")).toContain("left: 2ch");
    await w.setProps({ ruleFollow: false });
    await w.setProps({ cursor: { row: 1, col: 1 } });
    expect(style(w, ".rule-v")).toContain("left: 2ch");
    expect(style(w, ".rule-h")).toContain("top: 8.75em");
    w.unmount();
  });

  it("固定位置は画面が縮んでも画面の中に収める（27x132 → 24x80）", async () => {
    const big = snap([], { rows: 27, cols: 132 });
    const w = grid({ ruleLine: true, ruleFollow: false, cursor: { row: 27, col: 120 } }, big);
    await w.setProps({ snapshot: snap(), cursor: { row: 1, col: 1 } });
    expect(style(w, ".rule-v")).toContain("left: 79ch");
    expect(style(w, ".rule-h")).toContain("top: 30em");
    w.unmount();
  });

  it("フォーカスの無いペインでも出す（ACS: カーソルと違い、フォーカスが外れても消えない）", () => {
    const w = grid({ ruleLine: true, focused: false });
    expect(w.find(".rule-v").exists()).toBe(true);
    expect(w.find(".rule-h").exists()).toBe(true);
    w.unmount();
  });
});

/**
 * **jsdom は scoped CSS を計算しない**ので、見た目の要は SFC の宣言で固定する
 * （`grid-overlay-offset.test.ts` と同じ作法。実画素は scripts/verify-acs-display.mjs）。
 */
describe("描き方の宣言", () => {
  const REL = "src/components/ScreenGrid.vue";
  const SRC = readFileSync(existsSync(REL) ? REL : `packages/web-ui/${REL}`, "utf8");
  const css = (/<style scoped>([\s\S]*)<\/style>/.exec(SRC)?.[1] ?? "").replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = (sel: string) => {
    const i = css.indexOf(`${sel} {`);
    expect(i, `${sel} の規則が無い`).toBeGreaterThanOrEqual(0);
    return css.slice(i, css.indexOf("}", i));
  };

  it("カーソルは白を difference で重ねる（ACS の XOR＝下の字と地色の反転）", () => {
    expect(rule(".cursor")).toContain("mix-blend-mode: difference");
    expect(rule(".cursor")).toContain("background: #fff");
  });

  it("native キャレットは透明で、IME の変換中だけ見せる", () => {
    expect(rule(".grid-input")).toContain("caret-color: transparent");
    expect(rule('.grid[data-composing="true"] .grid-input:not([readonly])')).toContain("caret-color: currentColor");
  });

  it("明滅は 1 秒周期で、消える間は完全に消す", () => {
    expect(rule(".cursor.live")).toContain("cursorBlink 1s");
    expect(css).toMatch(/@keyframes cursorBlink \{\s*50% \{ opacity: 0; \}/);
  });

  it("ポインター＝十字線は画面と入力欄に効かせる", () => {
    expect(css).toMatch(/\.pane\[data-pointer="crosshair"\] \.grid,\s*\.pane\[data-pointer="crosshair"\] \.grid-input \{\s*cursor: crosshair;/);
  });
});
