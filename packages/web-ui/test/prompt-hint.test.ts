/**
 * **`F4` の導線。**
 *
 * `20260730-input-assist-datetime` の成果。backlog の datepicker / timepicker は
 * **実機で材料が無いと分かった**ため作らず（`EDTMSK` は欄を分解しない。research F1）、
 * 材料が揃っているこれだけを作った。
 *
 * 守ること:
 * 1. **語で判定しない**（ラベルは地域語。実機は `F4=ﾌﾟﾛﾝﾌﾟﾄ`）。`key === "F4"` で判定し、
 *    表示にはホストの凡例のラベルをそのまま使う
 * 2. **既定 OFF**（画面に部品を重ねるので勝手に有効化しない）
 * 3. **キーイベントを 1 つも購読しない** ＋ `mousedown` を `.stop.prevent`
 *    ＝矩形選択・コピー＆ペーストとフォーカスを妨げない（`opt-hints-ui.test.ts` と同じ不変条件）
 * 4. `tabindex="-1"`（タブ順の停止数を変えない）
 */
import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import ScreenGrid from "../src/components/ScreenGrid.vue";
import { detectPromptKey } from "../src/composables/fkeyLegend.js";
import { viewSettings, VIEW_ITEMS } from "../src/stores/viewSettings.js";
import type { Cell, Field, ScreenSnapshot } from "@as400web/core";

const SID = "pr1";

function cell(ch: string): Cell {
  return { char: ch, kind: "sbcs", color: "green", reverse: false, underline: false, blink: false, columnSeparator: false, nonDisplay: false };
}
function toCells(line: string, cols = 80): Cell[] {
  const out: Cell[] = [];
  for (const ch of line) out.push(cell(ch));
  while (out.length < cols) out.push(cell(" "));
  return out.slice(0, cols);
}

/** 入力欄 1 つ（行 5・桁 10・長 8）。右隣（桁 18）は空白のまま */
const FIELD: Field = {
  index: 0, row: 5, col: 10, length: 8,
  protected: false, numeric: false, hidden: false, mdt: false, value: "        "
} as Field;

/** `legend` を最下行に置いた画面 */
function snapOf(legend: string, fields: Field[] = [FIELD]): ScreenSnapshot {
  const lines = Array(24).fill("");
  lines[4] = "  日付      ";
  lines[21] = legend;
  const cells: Cell[][] = [];
  for (let r = 0; r < 24; r++) cells.push(toCells(lines[r] ?? "", 80));
  return { sessionId: SID, rows: 24, cols: 80, cursor: { row: 1, col: 1 }, keyboardLocked: false, cells, fields } as ScreenSnapshot;
}

const JP = " F3=終了   F4=プロンプト   F12=取り消し";
const NO_F4 = " F3=終了   F12=取り消し";

function mountGrid(promptHint: boolean, legend = JP, fields: Field[] = [FIELD]) {
  return mount(ScreenGrid, {
    props: { snapshot: snapOf(legend, fields), edits: new Map(), focused: true, promptHint },
    attachTo: document.body
  });
}
const input = (w: ReturnType<typeof mountGrid>) => w.find('input.grid-input[data-field-index="0"]');

describe("detectPromptKey: 語ではなくキーで判定する", () => {
  it("凡例に F4 があれば返す", () => {
    const s = detectPromptKey(snapOf(JP));
    expect(s?.key).toBe("F4");
  });

  it("**ラベルはホストのものをそのまま返す**（UI 側で言い換えない）", () => {
    expect(detectPromptKey(snapOf(JP))?.label).toBe("プロンプト");
  });

  it("英語の凡例でも同じく拾える（語に依存しない）", () => {
    const s = detectPromptKey(snapOf(" F3=Exit   F4=Prompt   F12=Cancel"));
    expect(s?.key).toBe("F4");
    expect(s?.label).toBe("Prompt");
  });

  it("**F4 のラベルが別の意味でも拾う**（意味を決めるのはホスト）", () => {
    expect(detectPromptKey(snapOf(" F4=一覧表示"))?.label).toBe("一覧表示");
  });

  it("F4 が無ければ null", () => {
    expect(detectPromptKey(snapOf(NO_F4))).toBeNull();
  });
});

describe("ボタンを出す条件", () => {
  it("既定（設定 OFF）では出ない", async () => {
    const w = mountGrid(false);
    await input(w).trigger("focus");
    await nextTick();
    expect(w.find(".prompt-btn").exists()).toBe(false);
    w.unmount();
  });

  it("設定 ON ＋ F4 の凡例 ＋ 入力欄にフォーカスで出る", async () => {
    const w = mountGrid(true);
    await input(w).trigger("focus");
    await nextTick();
    expect(w.find(".prompt-btn").exists()).toBe(true);
    w.unmount();
  });

  it("凡例に F4 が無ければ出ない", async () => {
    const w = mountGrid(true, NO_F4);
    await input(w).trigger("focus");
    await nextTick();
    expect(w.find(".prompt-btn").exists()).toBe(false);
    w.unmount();
  });

  it("フォーカスが無ければ出ない（フォーカスに完全従属）", async () => {
    const w = mountGrid(true);
    await nextTick();
    expect(w.find(".prompt-btn").exists()).toBe(false);
    w.unmount();
  });

  it("フォーカスが外れると消える", async () => {
    const w = mountGrid(true);
    await input(w).trigger("focus");
    await nextTick();
    expect(w.find(".prompt-btn").exists()).toBe(true);
    await input(w).trigger("blur");
    await nextTick();
    expect(w.find(".prompt-btn").exists()).toBe(false);
    w.unmount();
  });

  it("ラベルは title / aria-label にホストの語が入る", async () => {
    const w = mountGrid(true);
    await input(w).trigger("focus");
    await nextTick();
    const b = w.find(".prompt-btn");
    expect(b.attributes("title")).toBe("プロンプト");
    expect(b.attributes("aria-label")).toBe("プロンプト");
    w.unmount();
  });

  /**
   * **固定文字列を出していないことの証拠。** 「プロンプト」だけで確かめると、
   * 実装がその語を決め打ちしていても同じ結果になる（空振り検証で実際に見逃した）。
   * ホストが別の語を書いている画面で確かめる。
   */
  it("**ホストが別の語を書いていればその語が出る**（決め打ちしていない）", async () => {
    const w = mountGrid(true, " F3=終了   F4=一覧表示");
    await input(w).trigger("focus");
    await nextTick();
    const b = w.find(".prompt-btn");
    expect(b.attributes("title")).toBe("一覧表示");
    expect(b.attributes("aria-label")).toBe("一覧表示");
    w.unmount();
  });

  /**
   * 置き場は「欄の直後 → 空いていなければ欄の直前」。
   *
   * 直前へ退避できることが要る——**コマンド行は実機で長さ 153**（行またぎ）で
   * 画面の右端まで届くため、右にはどうしても場所が無い。5250 は SF の属性バイトを
   * 欄の手前に置くので、直前は空白で空いている（`probe-opt-adjacency.mjs` の実測）。
   */
  async function mountWith(mutate: (s: ScreenSnapshot) => void) {
    const s = snapOf(JP);
    mutate(s);
    const w = mount(ScreenGrid, {
      props: { snapshot: s, edits: new Map(), focused: true, promptHint: true },
      attachTo: document.body
    });
    await w.find('input.grid-input[data-field-index="0"]').trigger("focus");
    await nextTick();
    return w;
  }

  it("既定では欄の直後（桁 18）に置く", async () => {
    const w = await mountWith(() => {});
    expect(w.find(".prompt-btn").attributes("style")).toContain("left: 17ch");
    w.unmount();
  });

  it("**直後が埋まっていれば欄の直前へ退避する**（コマンド行のような行末までの欄のため）", async () => {
    const w = await mountWith((s) => {
      s.cells[4]![17] = cell("|"); // 桁 18 を塞ぐ
    });
    expect(w.find(".prompt-btn").attributes("style")).toContain("left: 8ch"); // 桁 9 = 欄の直前
    w.unmount();
  });

  it("直後も直前も埋まっていれば出さない（桁を踏まない）", async () => {
    const w = await mountWith((s) => {
      s.cells[4]![17] = cell("|"); // 直後
      s.cells[4]![8] = cell("|"); // 直前（桁 9）
    });
    expect(w.find(".prompt-btn").exists()).toBe(false);
    w.unmount();
  });
});

describe("押したときの振る舞い", () => {
  it("F4 を AID として送る", async () => {
    const w = mountGrid(true);
    await input(w).trigger("focus");
    await nextTick();
    await w.find(".prompt-btn").trigger("click");
    expect(w.emitted("aid")).toEqual([["F4"]]);
    w.unmount();
  });

  it("フォーカスしただけでは何も送らない（明示操作だけ）", async () => {
    const w = mountGrid(true);
    await input(w).trigger("focus");
    await nextTick();
    expect(w.emitted("aid")).toBeUndefined();
    w.unmount();
  });
});

describe("不変条件: 矩形選択・コピー・タブ順を妨げない", () => {
  it("キーイベントを 1 つも購読していない", async () => {
    const w = mountGrid(true);
    await input(w).trigger("focus");
    await nextTick();
    const html = w.find(".prompt-btn").html();
    expect(html).not.toMatch(/keydown|keyup|keypress/i);
    w.unmount();
  });

  it("タブ順に入れない（一覧を Tab で降りる停止数を変えない）", async () => {
    const w = mountGrid(true);
    await input(w).trigger("focus");
    await nextTick();
    expect(w.find(".prompt-btn").attributes("tabindex")).toBe("-1");
    w.unmount();
  });

  it("mousedown でフォーカスが移らない（入力欄に残る）", async () => {
    const w = mountGrid(true);
    const el = input(w);
    await el.trigger("focus");
    await nextTick();
    const ev = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    w.find(".prompt-btn").element.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true); // 既定のフォーカス移動を止めている
    expect(document.activeElement).toBe(el.element);
    w.unmount();
  });
});

describe("画面設定", () => {
  it("既定は OFF", () => {
    expect(viewSettings.settings.promptHint).toBe(false);
  });

  it("VIEW_ITEMS に出る（メニューとキー設定の両方に自動で出る単一の出どころ）", () => {
    const item = VIEW_ITEMS.find((i) => i.key === "promptHint");
    expect(item).toBeDefined();
    expect(item?.opts.map((o) => o.value)).toEqual([true, false]);
  });
});
