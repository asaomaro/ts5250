import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick, reactive } from "vue";
import ScreenGrid from "../src/components/ScreenGrid.vue";
import { VIEW_ITEMS, viewSettings } from "../src/stores/viewSettings.js";
import { MSG_DATE_PICKER, MSG_DTP_FORMAT, MSG_TIME_PICKER } from "../src/composables/opMessages.js";
import type { Cell, Field, ScreenSnapshot } from "@ts5250/tn5250";

/**
 * **日付・時刻ピッカー（UI）。**
 *
 * 利用者指示（2026-07-29・`optHints` と同一）: **矩形選択とコピー＆ペーストに影響を与えないこと。**
 * 担保は 3 点で、ここで固定する:
 *
 * 1. ポップオーバーの `mousedown` を `.stop` でグリッドへ伝播させない
 *    （伝播すると `onGridMousedown` → `clearRectSel()` が走り**矩形選択が消える**）
 * 2. `mousedown` を `.prevent` して既定のフォーカス移動を止める（**入力欄にフォーカスを残す**）
 * 3. **グリッドにキーイベントを 1 つも足さない**——ピッカー**自身**の `keydown`（`Esc`）だけを購読する
 *
 * **フォーカスしただけでは開かない**（`optHints` と同じ。開くのはクリックか `Alt+↓`）。
 * **既定は無効**（推測を含む機能を勝手に有効化しない）。
 */

const SID = "dtp1";
const ROW = 5;
const COL = 24;

function cell(ch = " "): Cell {
  return {
    char: ch, kind: "sbcs", color: "green", reverse: false, underline: false,
    blink: false, columnSeparator: false, nonDisplay: false
  } as Cell;
}
function fld(over: Partial<Field> & { index: number; col: number; length: number }): Field {
  return { row: ROW, protected: false, hidden: false, numeric: true, mdt: false, value: "", ...over } as Field;
}

/** 実機 `D8U` と同じ形: 4 桁 ＋ `/` ＋ 2 桁 ＋ `/` ＋ 2 桁（桁 24 から） */
const DATE_FIELDS: Field[] = [
  fld({ index: 0, col: COL, length: 4, continued: "first" }),
  fld({ index: 1, col: COL + 5, length: 2, continued: "middle" }),
  fld({ index: 2, col: COL + 8, length: 2, continued: "last" })
];
/** 実機 `TMW`（値あり）と同じ形: 2 桁 ＋ `:` ＋ 2 桁 ＋ `:` ＋ 2 桁 */
const TIME_FIELDS: Field[] = [
  fld({ index: 0, col: COL, length: 2, continued: "first" }),
  fld({ index: 1, col: COL + 3, length: 2, continued: "middle" }),
  fld({ index: 2, col: COL + 6, length: 2, continued: "last" })
];

function snapOf(fields: Field[], sep: string): ScreenSnapshot {
  const cells: Cell[][] = [];
  for (let r = 1; r <= 24; r++) {
    const row: Cell[] = [];
    for (let c = 1; c <= 80; c++) row.push(cell());
    cells.push(row);
  }
  for (let i = 0; i + 1 < fields.length; i++) {
    const a = fields[i]!;
    cells[ROW - 1]![a.col + a.length - 1] = cell(sep);
  }
  return {
    sessionId: SID, rows: 24, cols: 80, cursor: { row: ROW, col: COL },
    keyboardLocked: false, cells, fields
  } as unknown as ScreenSnapshot;
}

function mountGrid(
  dtPicker: "none" | "panel",
  fields = DATE_FIELDS,
  sep = "/",
  insertMode = false,
  edits = new Map<number, string>()
) {
  return mount(ScreenGrid, {
    props: { snapshot: snapOf(fields, sep), edits, focused: true, dtPicker, insertMode },
    attachTo: document.body
  });
}
const firstInput = (w: ReturnType<typeof mountGrid>) =>
  w.find('input.grid-input[data-field-index="0"]');

async function open(w: ReturnType<typeof mountGrid>) {
  await w.find(".dtp-btn").trigger("click");
  await nextTick();
}

describe("既定は無効（勝手に有効化しない）", () => {
  it("保存値の既定が none", () => {
    expect(viewSettings.settings.dtPicker).toBe("none");
  });

  it("設定 OFF ではボタンもピッカーも出ない", async () => {
    const w = mountGrid("none");
    await firstInput(w).trigger("focus");
    await nextTick();
    expect(w.find(".dtp-btn").exists()).toBe(false);
    expect(w.find(".dtp").exists()).toBe(false);
    w.unmount();
  });

  it("画面設定メニューとキー設定に項目が出る（VIEW_ITEMS が単一の出どころ）", () => {
    const item = VIEW_ITEMS.find((i) => i.key === "dtPicker");
    expect(item).toBeDefined();
    expect(item!.opts.map((o) => o.value)).toEqual(["none", "panel", "outline", "crt"]);
  });
});

describe("導線", () => {
  it("設定 ON なら最終区間の右隣 1 桁にボタンが出る（フォーカス不要）", async () => {
    const w = mountGrid("panel");
    const btn = w.find(".dtp-btn");
    expect(btn.exists()).toBe(true);
    // 24..27 / 29..30 / 32..33 → 右隣は 34（0 始まりで 33ch）
    expect((btn.element as HTMLElement).style.left).toBe("33ch");
    w.unmount();
  });

  it("**フォーカスしただけでは開かない**（一覧を移動するたびに視界を塞がない）", async () => {
    const w = mountGrid("panel");
    await firstInput(w).trigger("focus");
    await nextTick();
    expect(w.find(".dtp").exists()).toBe(false);
    w.unmount();
  });

  it("ボタンを押すと開き、もう一度押すと閉じる", async () => {
    const w = mountGrid("panel");
    await open(w);
    expect(w.find(".dtp").exists()).toBe(true);
    await w.find(".dtp-btn").trigger("click");
    await nextTick();
    expect(w.find(".dtp").exists()).toBe(false);
    w.unmount();
  });

  it("タブ順に入れるのは開いている間だけ（Tab の停止数を増やさない）", async () => {
    const w = mountGrid("panel");
    expect(w.find(".dtp-btn").attributes("tabindex")).toBe("-1");
    await open(w);
    expect(w.find(".dtp-btn").attributes("tabindex")).toBe("0");
    w.unmount();
  });
});

describe("解釈中の書式を名乗る（桁順を固定している以上の責任）", () => {
  it("日付欄では YYYY/MM/DD と出す", async () => {
    const w = mountGrid("panel");
    await open(w);
    expect(w.find(".dtp-fmt").text()).toBe(MSG_DTP_FORMAT("YYYY/MM/DD"));
    expect(w.find(".dtp").attributes("aria-label")).toBe(MSG_DATE_PICKER);
    w.unmount();
  });

  it("時刻欄（`:`）では HH:MM:SS と出し、タブは出さない（種別が確定している）", async () => {
    const w = mountGrid("panel", TIME_FIELDS, ":");
    await open(w);
    expect(w.find(".dtp-fmt").text()).toBe(MSG_DTP_FORMAT("HH:MM:SS"));
    expect(w.find(".dtp").attributes("aria-label")).toBe(MSG_TIME_PICKER);
    expect(w.find(".dtp-btn").attributes("aria-label")).toBe(MSG_TIME_PICKER); // ボタンも種別を名乗る
    expect(w.find(".dtp-tabs").exists()).toBe(false);
    w.unmount();
  });

  /**
   * **`Field.value` はホストが送った値**で、打ったばかりの未送信の編集を含まない。
   * これを見ずに開くと「打った日付ではなく今日」でカレンダーが出る（review M2）。
   * 実行日に依存しない年（2019）で固定する。
   */
  it("未送信の編集込みの現在値からカレンダーを開く（今日ではない）", async () => {
    const w = mountGrid("panel", DATE_FIELDS, "/", false, reactive(new Map([[0, "2019"], [1, "03"], [2, "07"]])));
    await open(w);
    expect(w.find(".dtp-ym").text()).toBe("2019/03");
    w.unmount();
  });

  it("値が読めないときは今日で開くが、日は選択済みにしない（欄は書き換えない）", async () => {
    const w = mountGrid("panel");
    await open(w);
    const now = new Date();
    expect(w.find(".dtp-ym").text()).toBe(`${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, "0")}`);
    expect(w.findAll('.dtp-day[aria-pressed="true"]')).toHaveLength(0);
    expect(w.emitted("edit")).toBeUndefined(); // 開いただけでは 1 桁も変えない
    w.unmount();
  });

  it("区切りが画面に出ていない 2,2,2 では日付 / 時刻のタブを出す（decisions D3）", async () => {
    const w = mountGrid("panel", TIME_FIELDS, " ");
    await open(w);
    expect(w.find(".dtp-tabs").exists()).toBe(true);
    expect(w.findAll(".dtp-tab").map((t) => t.text())).toEqual(["日付", "時刻"]);
    w.unmount();
  });
});

describe("選ぶと欄が変わる（既存の貼り付け経路で書く）", () => {
  it("日付を選ぶと全区間へ分配され、ピッカーは閉じる", async () => {
    const w = mountGrid("panel");
    await open(w);
    // 見えている月の 1 日を押す
    await w.findAll(".dtp-day")[0]!.trigger("click");
    await nextTick();

    const edits = (w.emitted("edit") as unknown[][] | undefined) ?? [];
    const byIndex = new Map(edits.map(([i, v]) => [i as number, v as string]));
    // 年 4 桁 / 月 2 桁 / 日 "01"
    expect(byIndex.get(2)).toBe("01");
    expect((byIndex.get(0) ?? "").length).toBe(4);
    expect((byIndex.get(1) ?? "").length).toBe(2);
    expect(w.find(".dtp").exists()).toBe(false); // 日付は 1 クリックで定まるので閉じる
    w.unmount();
  });

  /**
   * **書き込みでピッカーが閉じてはいけない。** 検出（`dateTimeTargets`）を欄の値に依存させると、
   * 自分の書き込みで作り直され、それを監視している close の watch が発火して**1 列選んだ時点で
   * 閉じる**——実機 E2E で踏んだ（decisions D14）。3 列とも選べることで固定する。
   */
  it("時刻は列を選ぶたびに書き、**3 列とも**選べる（途中で閉じない）", async () => {
    // **`reactive` にするのが要点。** アプリ側の `edits` は `sessionsStore`（`reactive`）配下の
    // Map で、`set` が Vue の依存を発火させる。素の Map で書くと「値に依存する computed が
    // 作り直される」現象そのものが再現せず、テストが素通りする（実際に踏んだ）。
    const edits = reactive(new Map<number, string>());
    const w = mountGrid("panel", TIME_FIELDS, ":", false, edits);
    // 親（EmulatorPane）と同じく emit された編集を書き戻す（閉じる条件を実運用に合わせる）
    const pump = () => {
      for (const [i, v] of (w.emitted("edit") as unknown[][] | undefined) ?? []) edits.set(i as number, v as string);
    };
    await open(w);
    const cols = () => w.findAll(".dtp-col");
    await cols()[0]!.findAll(".dtp-cell")[13]!.trigger("click"); // 13 時
    pump(); await nextTick();
    expect(w.find(".dtp").exists()).toBe(true);
    await cols()[1]!.findAll(".dtp-cell")[30]!.trigger("click"); // 30 分
    pump(); await nextTick();
    expect(w.find(".dtp").exists()).toBe(true);
    await cols()[2]!.findAll(".dtp-cell")[15]!.trigger("click"); // 15 秒
    pump(); await nextTick();
    expect(w.find(".dtp").exists()).toBe(true);

    expect([edits.get(0), edits.get(1), edits.get(2)]).toEqual(["13", "30", "15"]);
    w.unmount();
  });

  it("**既に値の入った欄**でも挿入モードで弾かれない（`MSG_NO_ROOM` が出ない）", async () => {
    // `insertInto` は base の末尾空白を落とすので**空欄では溢れない**。溢れるのは
    // **既に値が入っているとき**——`"2020"` の 4 桁欄へ `"2026"` を offset 0 へ挿すと 8 桁になる。
    // ピッカーはカーソル位置への貼り付けではなく**欄の値の置き換え**なので `forceOverwrite` で書く。
    const filled: Field[] = [
      fld({ index: 0, col: COL, length: 4, continued: "first", value: "2020" }),
      fld({ index: 1, col: COL + 5, length: 2, continued: "middle", value: "01" }),
      fld({ index: 2, col: COL + 8, length: 2, continued: "last", value: "01" })
    ];
    const w = mountGrid("panel", filled, "/", true);
    await firstInput(w).trigger("focus");
    await nextTick();
    await open(w);
    // 前の月へ送ってから選ぶ＝**3 区間すべてが変わる**（年をまたぐので区間 0 も動く）
    await w.find(".dtp-step").trigger("click"); // 2020/01 → 2019/12
    await w.findAll(".dtp-day")[14]!.trigger("click"); // 15 日
    await nextTick();

    expect(w.emitted("notice")).toBeUndefined();
    const byIndex = new Map(((w.emitted("edit") as unknown[][] | undefined) ?? []).map(([i, v]) => [i as number, v as string]));
    expect(byIndex.get(0)).toBe("2019");
    expect(byIndex.get(1)).toBe("12");
    expect(byIndex.get(2)).toBe("15");
    w.unmount();
  });
});

describe("矩形選択・クリップボードを妨げない", () => {
  it("ピッカーの mousedown はグリッドへ伝播しない", async () => {
    const w = mountGrid("panel");
    await open(w);
    let reached = false;
    w.element.addEventListener("mousedown", () => { reached = true; });
    await w.find(".dtp").trigger("mousedown");
    expect(reached).toBe(false);
    w.unmount();
  });

  it("日のボタンの mousedown も伝播せず、既定のフォーカス移動も止める", async () => {
    const w = mountGrid("panel");
    await open(w);
    let reached = false;
    w.element.addEventListener("mousedown", () => { reached = true; });
    const ev = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    w.findAll(".dtp-day")[0]!.element.dispatchEvent(ev);
    expect(reached).toBe(false);
    expect(ev.defaultPrevented).toBe(true); // フォーカスが入力欄に残る＝貼り付け先が変わらない
    w.unmount();
  });

  it("開閉ボタンの mousedown も同じ（クリックはトグルだけを担う）", async () => {
    const w = mountGrid("panel");
    let reached = false;
    w.element.addEventListener("mousedown", () => { reached = true; });
    const ev = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    w.find(".dtp-btn").element.dispatchEvent(ev);
    expect(reached).toBe(false);
    expect(ev.defaultPrevented).toBe(true);
    w.unmount();
  });

  it("`Esc` はピッカー内で握り潰し、閉じる（他の Esc 割当を発火させない）", async () => {
    const w = mountGrid("panel");
    await open(w);
    const pop = w.find(".dtp").element as HTMLElement;
    let reachedGrid = false;
    w.element.addEventListener("keydown", () => { reachedGrid = true; });
    pop.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await nextTick();
    expect(reachedGrid).toBe(false);
    expect(w.find(".dtp").exists()).toBe(false);
    w.unmount();
  });

  it("外側を押したら閉じる（`preventDefault` はしない＝矩形選択のドラッグを潰さない）", async () => {
    const w = mountGrid("panel");
    await open(w);
    const ev = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    document.body.dispatchEvent(ev);
    await nextTick();
    expect(w.find(".dtp").exists()).toBe(false);
    expect(ev.defaultPrevented).toBe(false);
    w.unmount();
  });
});
