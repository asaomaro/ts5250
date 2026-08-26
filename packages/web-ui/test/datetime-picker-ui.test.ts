import { describe, it, expect, beforeEach } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { mount } from "@vue/test-utils";
import { nextTick, reactive } from "vue";
import ScreenGrid from "../src/components/ScreenGrid.vue";
import { VIEW_ITEMS, viewSettings, initViewSettings } from "../src/stores/viewSettings.js";
import ViewSettingsMenu from "../src/components/ViewSettingsMenu.vue";
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

describe("解釈中の書式は読み上げに残す（画面には出さない）", () => {
  /**
   * **書式の説明テキストは画面に出さない**（利用者指示 2026-08-26）——端末画面に重ねる
   * 小さな部品で、毎回同じ一文が場所を取る。ただし桁順は固定しているので、
   * **`aria-label` には残す**（読み上げでは何として入力されるか分かる）。
   */
  it("日付欄は aria-label に YYYY/MM/DD を含み、画面には書式を出さない", async () => {
    const w = mountGrid("panel");
    await open(w);
    expect(w.find(".dtp").attributes("aria-label")).toBe(`${MSG_DATE_PICKER}（${MSG_DTP_FORMAT("YYYY/MM/DD")}）`);
    expect(w.find(".dtp-fmt").exists()).toBe(false);
    w.unmount();
  });

  it("時刻欄（`:`）は HH:MM:SS を名乗り、タブも見出しも出さない（種別が確定している）", async () => {
    const w = mountGrid("panel", TIME_FIELDS, ":");
    await open(w);
    expect(w.find(".dtp").attributes("aria-label")).toBe(`${MSG_TIME_PICKER}（${MSG_DTP_FORMAT("HH:MM:SS")}）`);
    expect(w.find(".dtp-btn").attributes("aria-label")).toBe(MSG_TIME_PICKER); // ボタンも種別を名乗る
    expect(w.find(".dtp-tabs").exists()).toBe(false);
    // タブが無い欄では**見出しごと出さない**（空の余白を作らない）
    expect(w.find(".dtp-head").exists()).toBe(false);
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

/**
 * **画面設定から有効/無効とデザインを選べること。**
 *
 * backlog（`input-assist.md`）の上位要求:「ここに積んだ機能はすべて画面設定から有効/無効と
 * デザインを選べること。**勝手に有効化しない**」。`optHints` と同じく `VIEW_ITEMS` に足すことで、
 * **画面設定メニューとキー設定（順送り）の両方に自動で出る**——2 か所に書かない。
 */
describe("画面設定から選べる（optHints と同じ仕組み）", () => {
  beforeEach(() => {
    localStorage.clear();
    initViewSettings();
  });

  it("画面設定メニューに「日付・時刻の選択」の行が出て、意匠を 4 つから選べる", async () => {
    // 5250 ペインの設定メニューは `keys` を渡さない＝ VIEW_ITEMS 全部を出す
    // （帳票ペインだけ `linkify` / `font` に絞られる。App.vue の REPORT_VIEW_KEYS）
    const w = mount(ViewSettingsMenu, { props: { sessionId: "dtp-menu" }, attachTo: document.body });
    await w.find(".vsm-btn").trigger("click"); // ⚙ 表示 を開く
    await nextTick();

    const rows = w.findAll(".vsm-row");
    const row = rows.find((r) => r.find(".vsm-label").exists() && r.find(".vsm-label").text().includes("日付・時刻の選択"));
    expect(row, "画面設定メニューに項目が出ていない").toBeDefined();

    // 候補が多い項目は畳んである（`expandable`）。開いて初めてデザイン候補が並ぶ
    await row!.find(".vsm-toggle").trigger("click");
    await nextTick();
    const pal = w.findAll(".vsm-palette").find((g) => g.attributes("aria-label") === "日付・時刻の選択のデザイン");
    expect(pal, "デザイン候補が出ていない").toBeDefined();
    expect(pal!.findAll(".pal-name").map((b) => b.text().replace("·", "").trim())).toEqual([
      "無効", "パネル", "枠", "端末調"
    ]);

    // 選ぶと保存値が変わる（＝ここから有効化とデザインの変更ができる）
    await pal!.findAll(".pal-item")[3]!.trigger("click");
    expect(viewSettings.settings.dtPicker).toBe("crt");
    w.unmount();
  });

  it("キー設定の順送りで 無効 → パネル → 枠 → 端末調 → 無効 と一巡する", () => {
    expect(viewSettings.settings.dtPicker).toBe("none");
    for (const expected of ["panel", "outline", "crt", "none"] as const) {
      viewSettings.cycle("dtPicker");
      expect(viewSettings.settings.dtPicker).toBe(expected);
    }
  });

  it("選んだ意匠が実際にピッカーへ効く（`data-pop`）", async () => {
    for (const style of ["panel", "outline", "crt"] as const) {
      const w = mount(ScreenGrid, {
        props: { snapshot: snapOf(DATE_FIELDS, "/"), edits: new Map(), focused: true, dtPicker: style },
        attachTo: document.body
      });
      await w.find(".dtp-btn").trigger("click");
      await nextTick();
      expect(w.find(".dtp").attributes("data-pop")).toBe(style);
      expect(w.find(".dtp").classes()).toContain("crt-pop"); // 共通の意匠（styles.css）に載る
      w.unmount();
    }
  });
});

/**
 * **キーボードだけで操作を完結できること**（`optHints` のリストと同じ約束）。
 *
 * 開いた直後にフォーカスがピッカーへ移らないと、矢印も `Enter` も欄へ行ってしまい
 * マウスが要る。さらに時刻は「選んでも開いたまま」なので、**1 列選ぶたびに欄へ
 * フォーカスを戻されると分・秒へ進めない**（`pasteFrom` の `sync` が欄へ移すため）。
 */
describe("キーボードだけで完結する", () => {
  const active = () => document.activeElement as HTMLElement | null;

  it("開くとフォーカスがピッカーへ移る（欄に残らない）", async () => {
    const w = mountGrid("panel");
    await open(w);
    expect(active()?.closest(".dtp")).not.toBeNull();
    w.unmount();
  });

  it("日付は「選択済み ＞ 今日」の順で初期フォーカスが決まる", async () => {
    const now = new Date();
    // 値が読めない欄 → 今日にフォーカス
    const w1 = mountGrid("panel");
    await open(w1);
    expect(active()?.dataset.day).toBe(String(now.getDate()));
    expect(active()?.getAttribute("aria-current")).toBe("date");
    w1.unmount();

    // 値のある欄 → その日にフォーカス（実行日に依存しない年で固定）
    const w2 = mountGrid("panel", DATE_FIELDS, "/", false, reactive(new Map([[0, "2019"], [1, "03"], [2, "07"]])));
    await open(w2);
    expect(active()?.dataset.day).toBe("7");
    expect(active()?.getAttribute("aria-pressed")).toBe("true");
    w2.unmount();
  });

  it("矢印で日を移動する（左右で 1 日・上下で 1 週）", async () => {
    const w = mountGrid("panel", DATE_FIELDS, "/", false, reactive(new Map([[0, "2019"], [1, "03"], [2, "07"]])));
    await open(w);
    const key = async (k: string) => {
      await active()!.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
      await nextTick();
    };
    await key("ArrowRight");
    expect(active()?.dataset.day).toBe("8");
    await key("ArrowDown");
    expect(active()?.dataset.day).toBe("15");
    await key("ArrowUp");
    expect(active()?.dataset.day).toBe("8");
    await key("ArrowLeft");
    expect(active()?.dataset.day).toBe("7");
    w.unmount();
  });

  it("月をまたぐ移動では月が送られる", async () => {
    const w = mountGrid("panel", DATE_FIELDS, "/", false, reactive(new Map([[0, "2019"], [1, "03"], [2, "01"]])));
    await open(w);
    expect(w.find(".dtp-ym").text()).toBe("2019/03");
    active()!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }));
    await nextTick();
    await nextTick();
    expect(w.find(".dtp-ym").text()).toBe("2019/02"); // 3/1 の左は 2 月へ
    expect(active()?.dataset.day).toBe("28");
    w.unmount();
  });

  it("`Enter` で日を決められる（button の既定動作）", async () => {
    const w = mountGrid("panel", DATE_FIELDS, "/", false, reactive(new Map([[0, "2019"], [1, "03"], [2, "07"]])));
    await open(w);
    await active()!.click(); // Enter/Space は button の click に落ちる
    await nextTick();
    const edits = new Map(((w.emitted("edit") as unknown[][] | undefined) ?? []).map(([i, v]) => [i as number, v as string]));
    expect(edits.get(2)).toBe("07");
    w.unmount();
  });

  it("時刻は列を選んでも**フォーカスがピッカーに残り**、矢印で次の列へ進める", async () => {
    const edits = reactive(new Map<number, string>());
    const w = mountGrid("panel", TIME_FIELDS, ":", false, edits);
    const pump = () => {
      for (const [i, v] of (w.emitted("edit") as unknown[][] | undefined) ?? []) edits.set(i as number, v as string);
    };
    await open(w);
    // 初期フォーカスは「時」の列の現在値
    expect(active()?.dataset.col).toBe("0");

    await active()!.click(); // その時を決定
    pump(); await nextTick();
    // **欄へ戻されていない**——ここが戻ると分・秒へ進めない
    expect(active()?.closest(".dtp")).not.toBeNull();

    active()!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    await nextTick();
    expect(active()?.dataset.col).toBe("1"); // 分の列へ
    active()!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    await nextTick();
    expect(active()?.dataset.col).toBe("2"); // 秒の列へ
    w.unmount();
  });

  it("列の中は上下で巡回する（0 時の上は 23 時）", async () => {
    const w = mountGrid("panel", TIME_FIELDS, ":", false, reactive(new Map([[0, "00"], [1, "00"], [2, "00"]])));
    await open(w);
    expect(active()?.dataset.val).toBe("0");
    active()!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true }));
    await nextTick();
    expect(active()?.dataset.val).toBe("23");
    w.unmount();
  });

  it("`both` はタブの左右で切り替わり、切り替え先の中身へフォーカスが移る", async () => {
    const w = mountGrid("panel", TIME_FIELDS, " "); // 区切りが空白＝both
    await open(w);
    expect(active()?.classList.contains("dtp-day")).toBe(true); // 既定は日付タブ
    const tabTime = w.findAll(".dtp-tab")[1]!;
    (tabTime.element as HTMLElement).focus();
    tabTime.element.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    await nextTick();
    await nextTick();
    expect(active()?.classList.contains("dtp-cell")).toBe(true); // 時刻の列へ移っている
    w.unmount();
  });

  it("`Esc` で閉じて欄へ戻る（フォーカスが宙に浮かない）", async () => {
    const w = mountGrid("panel");
    await open(w);
    active()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await nextTick();
    expect(w.find(".dtp").exists()).toBe(false);
    expect(active()?.classList.contains("grid-input")).toBe(true);
    w.unmount();
  });
});

/**
 * **`Tab` は部品の中で巡回する**（`composables/focusTrap.ts` をオプション選択肢と共有）。
 *
 * 抜けてしまうと、開いたままの部品へキーボードだけでは戻れない（外側クリックでしか
 * 閉じられない）。出口は `Esc` と選択——**キーで明示的に踏む**のが約束。
 *
 * 日のグリッド・時刻の列は**ロービング tabindex**で「まとまりで 1 停止点」にしてある。
 * 全部を tabindex 0 にすると `Tab` が 60 個の分を 1 つずつ辿ることになって使えない。
 */
describe("Tab はピッカーの中で巡回する", () => {
  const active = () => document.activeElement as HTMLElement | null;
  const tab = (shift = false) => {
    active()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: shift, bubbles: true, cancelable: true }));
  };
  const stops = (w: ReturnType<typeof mountGrid>) =>
    w.findAll('.dtp button:not([tabindex="-1"]), .dtp [tabindex="0"]');

  it("時刻の列は 1 列 1 停止点（60 個の分を 1 つずつ辿らない）", async () => {
    const w = mountGrid("panel", TIME_FIELDS, ":");
    await open(w);
    // 時 24 + 分 60 + 秒 60 = 144 個あるが、停止点は各列 1 つ
    expect(w.findAll(".dtp-cell").length).toBeGreaterThan(140);
    expect(stops(w).filter((e) => e.classes().includes("dtp-cell"))).toHaveLength(3);
    w.unmount();
  });

  it("日のグリッドも 1 停止点", async () => {
    const w = mountGrid("panel");
    await open(w);
    expect(w.findAll(".dtp-day").length).toBeGreaterThan(27);
    expect(stops(w).filter((e) => e.classes().includes("dtp-day"))).toHaveLength(1);
    w.unmount();
  });

  it("末尾で `Tab` を押すと先頭へ戻る（外へ抜けない）", async () => {
    const w = mountGrid("panel");
    await open(w);
    const list = stops(w).map((e) => e.element as HTMLElement);
    expect(list.length).toBeGreaterThan(1);

    list[list.length - 1]!.focus();
    tab();
    await nextTick();
    expect(active()).toBe(list[0]);
    expect(active()?.closest(".dtp")).not.toBeNull();
    w.unmount();
  });

  it("先頭で `Shift+Tab` を押すと末尾へ回る", async () => {
    const w = mountGrid("panel");
    await open(w);
    const list = stops(w).map((e) => e.element as HTMLElement);
    list[0]!.focus();
    tab(true);
    await nextTick();
    expect(active()).toBe(list[list.length - 1]);
    w.unmount();
  });

  /**
   * **「外へ出ない」だけを見ても意味が無い。** jsdom は合成 `keydown` で実際のタブ移動を
   * 起こさないので、トラップが無くてもフォーカスはその場に留まり素通りする（実際に踏んだ）。
   * **停止点を順に一周して先頭へ戻る**ことまで見る。
   */
  it("`Tab` を停止点の数だけ押すと一周して先頭へ戻る", async () => {
    const w = mountGrid("panel", TIME_FIELDS, ":");
    await open(w);
    const list = stops(w).map((e) => e.element as HTMLElement);
    expect(list.length).toBeGreaterThan(2);

    list[0]!.focus();
    const visited: HTMLElement[] = [];
    for (let i = 0; i < list.length; i++) {
      tab();
      await nextTick();
      expect(active()?.closest(".dtp"), `${i + 1} 回目で外へ出た`).not.toBeNull();
      visited.push(active()!);
    }
    expect(visited).toEqual([...list.slice(1), list[0]]);
    w.unmount();
  });
});

/**
 * **時刻の列にスクロールバーを出さない**（利用者指示 2026-08-26）。
 * 3 列それぞれに縦棒が立つと、端末画面に重ねる小さな部品としては騒がしい。
 * scoped CSS は vitest の DOM に効かないので**ビルド後の CSS を直接検査**する
 * （`view-cycle-ui.test.ts` の CRT 検査・`view-settings-palette.test.ts` の見本検査と同じ作法）。
 */
describe("時刻の列の見た目", () => {
  it("スクロールバーを消す指定がビルド後の CSS に載っている", () => {
    const dir = join(process.cwd(), "dist/assets");
    if (!existsSync(dir)) return; // 未ビルド時はスキップ
    const css = readdirSync(dir)
      .filter((f) => f.endsWith(".css"))
      .map((f) => readFileSync(join(dir, f), "utf8"))
      .join("\n");
    if (!css) return;
    // **`.dtp-cols`（列を並べる箱）に先に当たらないよう境界を効かせる。**
    // scoped CSS はクラス名の直後に `[data-v-…]` が付くので、そこまで含めて拾う。
    const col = /\.dtp-col\[data-v-[^\]]+\][^{]*\{[^}]*\}/.exec(css)?.[0] ?? "";
    expect(col, ".dtp-col の規則が見つからない").not.toBe("");
    expect(col).toContain("scrollbar-width:none");
    // WebKit 系は擬似要素で消す（別の規則になり、scoped の属性がクラス名の直後に入る）
    expect(/\.dtp-col\[data-v-[^\]]+\]::-webkit-scrollbar/.test(css), "WebKit 向けの指定が無い").toBe(true);
  });

  it("スクロール自体は残す（現在値まで送れる）", async () => {
    const w = mountGrid("panel", TIME_FIELDS, ":");
    await open(w);
    // 60 個の分が 11em に収まらない＝スクロールできる状態のままにしておく
    expect(w.findAll('.dtp-col')[1]!.findAll(".dtp-cell")).toHaveLength(60);
    w.unmount();
  });
});
