import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import ScreenGrid from "../src/components/ScreenGrid.vue";
import { MSG_OPT_HINTS } from "../src/composables/opMessages.js";
import type { Cell, Field, ScreenSnapshot } from "@as400web/tn5250";

/**
 * **オプション欄の選択肢（UI）。**
 *
 * 利用者指示（2026-07-29）: **矩形選択とコピー＆ペーストに影響を与えないこと。**
 * 実装は次の 3 点でそれを担保しており、ここで固定する:
 *
 * 1. ポップオーバーの `mousedown` を `.stop` でグリッドへ伝播させない
 *    （伝播すると `onGridMousedown` → `clearRectSel()` が走り**矩形選択が消える**）
 * 2. `mousedown` を `.prevent` して既定のフォーカス移動を止める
 *    （**入力欄にフォーカスを残す**。奪うと貼り付け先が変わる）
 * 3. **キーイベントを 1 つも購読しない**（矢印・Tab・Enter・Esc は今日と同じ経路）
 *
 * **フォーカスしただけではリストを開かない**（利用者指摘: 一覧を移動するたびに視界を塞ぐ）。
 * 出るのは右隣 1 桁のボタンだけで、開くのはクリックか `Alt+↓` のとき。
 * ボタンをタブ順に入れるのも**開いている間だけ**——常時入れると一覧を Tab で降りる停止数が倍になる。
 */

const SID = "opt1";

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

/** PDM 風の一覧: 凡例 2 行＋ c2/len2 の Opt 欄が 4 行 */
const LINES: string[] = (() => {
  const l = Array(24).fill("");
  l[0] = "  オブジェクトの処理";
  l[5] = "  オプションを入力して，実行キーを押してください。";
  l[6] = "   2=変更      3=コピー      4=削除      5=表示";
  l[7] = "   8=記述の表示              9=保管";
  l[9] = " OPT  オブジェクト   タイプ";
  for (let r = 10; r <= 13; r++) l[r] = "      OBJ" + (r - 9) + "        *PGM";
  l[21] = " F3=終了   F4=プロンプト";
  return l;
})();

// 画面行 11-14（LINES[10..13]）。**行 10 はヘッダー `OPT …` で c4 が埋まっている**ので避ける
const OPT_FIELDS: Field[] = [11, 12, 13, 14].map((row, i) => ({
  index: i, row, col: 2, length: 2,
  protected: false, numeric: false, hidden: false, mdt: false, value: "  "
}));

function snapOf(fields: Field[] = OPT_FIELDS): ScreenSnapshot {
  const cells: Cell[][] = [];
  for (let r = 0; r < 24; r++) cells.push(toCells(LINES[r] ?? "", 80));
  return {
    sessionId: SID, rows: 24, cols: 80, cursor: { row: 1, col: 1 },
    keyboardLocked: false, cells, fields
  } as ScreenSnapshot;
}

function mountGrid(optHints: "none" | "panel") {
  return mount(ScreenGrid, {
    props: { snapshot: snapOf(), edits: new Map(), focused: true, optHints },
    attachTo: document.body
  });
}

const firstOptInput = (w: ReturnType<typeof mountGrid>) =>
  w.find('input.grid-input[data-field-index="0"]');

describe("オプション欄の選択肢（UI）", () => {
  it("既定（設定 OFF）では欄にフォーカスしても何も出ない", async () => {
    const w = mountGrid("none");
    await firstOptInput(w).trigger("focus");
    await nextTick();
    expect(w.find(".opt-hints").exists()).toBe(false);
    w.unmount();
  });

  it("設定 ON でも**フォーカスだけではリストが出ない**（ボタンだけ出る）", async () => {
    const w = mountGrid("panel");
    await firstOptInput(w).trigger("focus");
    await nextTick();
    expect(w.find(".opt-hints").exists()).toBe(false);
    const btn = w.find(".opt-btn");
    expect(btn.exists()).toBe(true);
    // 開くまではタブ順に入れない（一覧を Tab で降りる停止数を増やさない）
    expect(btn.attributes("tabindex")).toBe("-1");
    w.unmount();
  });

  it("ボタンを押すとリストが開き、タブ順に入る", async () => {
    const w = mountGrid("panel");
    await firstOptInput(w).trigger("focus");
    await nextTick();
    await w.find(".opt-btn").trigger("click");
    await nextTick();
    const pop = w.find(".opt-hints");
    expect(pop.exists()).toBe(true);
    expect(w.find(".opt-btn").attributes("tabindex")).toBe("0");
    expect(w.findAll(".opt-hint").every((i) => i.attributes("tabindex") === "0")).toBe(true);
    expect(pop.attributes("aria-label")).toBe(MSG_OPT_HINTS);
    const items = w.findAll(".opt-hint");
    expect(items.map((i) => i.find(".opt-hint-n").text())).toEqual(["2", "3", "4", "5", "8", "9"]);
    expect(items[0]!.find(".opt-hint-l").text()).toBe("変更");
    w.unmount();
  });

  it("**右隣 1 桁が埋まっている行にはボタンを出さない**（他の行には出る）", () => {
    // DSPF 検証（scripts/probe-opt-adjacency.mjs）のとおり、右隣に入力欄は来ないが
    // 「必ず属性バイト（空白）」ではない——閉じ属性を送らないと定数が来うる。
    // 行 10 はヘッダー `OPT …` で c4 が `T` に埋まっているので、その行だけ出さない
    const w = mount(ScreenGrid, {
      props: {
        snapshot: snapOf([10, 11, 12].map((row, i) => ({
          index: i, row, col: 2, length: 2,
          protected: false, numeric: false, hidden: false, mdt: false, value: "  "
        }))),
        edits: new Map(), focused: true, optHints: "panel"
      },
      attachTo: document.body
    });
    // 行 11・12 には出るが、行 10 には出ない
    expect(w.findAll(".opt-btn").length).toBe(2);
    w.unmount();
  });

  it("ボタンは**フォーカスに関係なく各 Opt 行に常時**出る", () => {
    const w = mountGrid("panel");
    expect(w.findAll(".opt-btn").length).toBe(OPT_FIELDS.length);
    w.unmount();
  });

  it("開いたら**選択中（無ければ先頭）の項目にフォーカスが移る**", async () => {
    const w = mountGrid("panel");
    await firstOptInput(w).trigger("focus");
    await nextTick();
    await w.find(".opt-btn").trigger("click");
    await nextTick();
    await nextTick();
    expect(document.activeElement?.classList.contains("opt-hint")).toBe(true);
    w.unmount();
  });

  it("**既に入っている値が選択肢にあれば選択状態にする**", async () => {
    const fields = OPT_FIELDS.map((f, i) => (i === 0 ? { ...f, value: "3 " } : f));
    const w = mount(ScreenGrid, {
      props: { snapshot: snapOf(fields), edits: new Map(), focused: true, optHints: "panel" },
      attachTo: document.body
    });
    await w.find(".opt-btn").trigger("click");
    await nextTick();
    const sel = w.findAll(".opt-hint").filter((i) => i.attributes("aria-selected") === "true");
    expect(sel.length).toBe(1);
    expect(sel[0]!.find(".opt-hint-n").text()).toBe("3");
    w.unmount();
  });

  describe("矩形選択・クリップボードを妨げない", () => {
    it("ポップオーバーの mousedown はグリッドへ伝播しない", async () => {
      const w = mountGrid("panel");
      await firstOptInput(w).trigger("focus");
      await nextTick();
      await w.find(".opt-btn").trigger("click");
      await nextTick();

      let reached = false;
      w.element.addEventListener("mousedown", () => { reached = true; });
      await w.find(".opt-hints").trigger("mousedown");
      // 伝播すると onGridMousedown が走り clearRectSel() で矩形選択が消える
      expect(reached).toBe(false);
      w.unmount();
    });

    it("項目の mousedown もグリッドへ伝播せず、既定動作（フォーカス移動）も止める", async () => {
      const w = mountGrid("panel");
      await firstOptInput(w).trigger("focus");
      await nextTick();
      await w.find(".opt-btn").trigger("click");
      await nextTick();

      let reached = false;
      w.element.addEventListener("mousedown", () => { reached = true; });
      const ev = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
      w.find(".opt-hint").element.dispatchEvent(ev);
      expect(reached).toBe(false);
      // preventDefault されていれば既定のフォーカス移動が起きない＝貼り付け先が変わらない
      expect(ev.defaultPrevented).toBe(true);
      w.unmount();
    });

    it("**Esc はリスト内で握り潰す**（開いている間は他の Esc 割当を発火させない）", async () => {
      const w = mountGrid("panel");
      await w.find(".opt-btn").trigger("click");
      await nextTick();
      const pop = w.find(".opt-hints").element as HTMLElement;

      let reachedGrid = false;
      w.element.addEventListener("keydown", () => { reachedGrid = true; });
      const ev = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
      pop.dispatchEvent(ev);
      await nextTick();

      expect(ev.defaultPrevented).toBe(true);
      expect(reachedGrid).toBe(false); // 伝播しない＝矩形選択の解除等が走らない
      expect(w.find(".opt-hints").exists()).toBe(false); // 閉じている
      w.unmount();
    });

    it("Esc・矢印以外のキーは素通りする", async () => {
      const w = mountGrid("panel");
      await w.find(".opt-btn").trigger("click");
      await nextTick();
      const pop = w.find(".opt-hints").element as HTMLElement;
      const ev = new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true });
      pop.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(false);
      w.unmount();
    });
  });

  describe("外側クリックで閉じる", () => {
    it("リストの外を押すと閉じる", async () => {
      const w = mountGrid("panel");
      await w.find(".opt-btn").trigger("click");
      await nextTick();
      expect(w.find(".opt-hints").exists()).toBe(true);

      document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      await nextTick();
      expect(w.find(".opt-hints").exists()).toBe(false);
      w.unmount();
    });

    it("リストの中を押しても閉じない", async () => {
      const w = mountGrid("panel");
      await w.find(".opt-btn").trigger("click");
      await nextTick();
      w.find(".opt-hint").element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      await nextTick();
      expect(w.find(".opt-hints").exists()).toBe(true);
      w.unmount();
    });

    it("**閉じるだけで矩形選択のドラッグ開始を潰さない**", async () => {
      const w = mountGrid("panel");
      await w.find(".opt-btn").trigger("click");
      await nextTick();
      const ev = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
      document.body.dispatchEvent(ev);
      await nextTick();
      expect(ev.defaultPrevented).toBe(false); // preventDefault も stopPropagation もしない
      w.unmount();
    });
  });

  describe("見せ方の設定", () => {
    it("既定（none）では検出も走らせない", () => {
      const w = mountGrid("none");
      expect(w.findAll(".opt-btn").length).toBe(0);
      w.unmount();
    });

    it("意匠は data 属性で切り替える（CSS の当て先）", () => {
      const w = mountGrid("panel");
      expect(w.element.getAttribute("data-opt-hints")).toBe("panel");
      w.unmount();
    });
  });

  it("選ぶと欄へ番号が入る", async () => {
    const w = mountGrid("panel");
    await firstOptInput(w).trigger("focus");
    await nextTick();
    await w.find(".opt-btn").trigger("click");
    await nextTick();
    await w.findAll(".opt-hint")[1]!.trigger("click"); // 3=コピー
    await nextTick();
    expect((firstOptInput(w).element as HTMLInputElement).value.trim()).toBe("3");
    w.unmount();
  });
});
