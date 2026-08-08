import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import ScreenGrid from "../src/components/ScreenGrid.vue";
import type { ScreenSnapshot, Cell, Field } from "@ts5250/tn5250";

/**
 * ホストが送ったカーソル位置を**桁まで**再現する。
 *
 * SEU は確定・F キー・スクロールの後もカーソルを元の桁に置いて返す（入力位置を保つ仕様）。
 * こちらが欄の先頭や第 1 欄へ寄せると、その意図を毎回潰す。
 *
 * 旧実装の取りこぼしは 2 つ。
 *  - 欄単位の添字で、行またぎで分割された input（スライス単位）の NodeList を引いていた。
 *    SEU のように欄が折り返す画面では添字がずれ、無関係な欄へ飛ぶ。
 *  - 桁を捨てて常に先頭（offset 0）へ置いていた。
 */
function cell(): Cell {
  return {
    char: " ",
    kind: "sbcs",
    color: "green",
    reverse: false,
    underline: false,
    blink: false,
    columnSeparator: false,
    nonDisplay: false
  };
}

function snap(fields: Field[], cursor: { row: number; col: number }): ScreenSnapshot {
  const cells: Cell[][] = [];
  for (let r = 0; r < 24; r++) {
    const row: Cell[] = [];
    for (let c = 0; c < 80; c++) row.push(cell());
    cells.push(row);
  }
  return { sessionId: "s1", rows: 24, cols: 80, cursor, keyboardLocked: false, cells, fields };
}

function fld(index: number, row: number, col: number, length: number): Field {
  return { index, row, col, length, protected: false, hidden: false, numeric: false, mdt: false, value: "" };
}

/** SEU 相当: 80 桁画面に長さ 100 の欄（＝行をまたいで 2 スライスに割れる）を 2 本 */
const FIELDS = [fld(1, 2, 1, 100), fld(2, 5, 1, 100)];

function mountGrid(cursor: { row: number; col: number }) {
  return mount(ScreenGrid, {
    props: { snapshot: snap(FIELDS, cursor), edits: new Map(), focused: false },
    attachTo: document.body
  });
}

async function focusPane(w: ReturnType<typeof mountGrid>) {
  await w.setProps({ focused: true });
  await nextTick();
  await nextTick();
}

describe("ホストのカーソル位置を桁まで再現する", () => {
  it("折り返した欄の 2 スライス目でも、その欄・その桁へフォーカスする", async () => {
    // 欄2（行5 開始・長さ100）は 行5 に 80 桁、行6 に 20 桁。行6 桁5 は欄先頭から 84 桁目
    const w = mountGrid({ row: 6, col: 5 });
    await focusPane(w);
    const el = document.activeElement as HTMLInputElement;
    expect(el.tagName).toBe("INPUT");
    expect(el.dataset["fieldIndex"], "別の欄へ飛んでいる").toBe("2");
    expect(el.dataset["slice"], "折り返し後のスライスでない").toBe("1");
    expect(el.selectionStart, "桁が先頭へ寄せられている").toBe(4); // 84 - 80
    w.unmount();
  });

  it("欄の途中の桁を指されたら、その桁にキャレットを置く", async () => {
    const w = mountGrid({ row: 2, col: 31 }); // 欄1 の 31 桁目
    await focusPane(w);
    const el = document.activeElement as HTMLInputElement;
    expect(el.dataset["fieldIndex"]).toBe("1");
    expect(el.dataset["slice"]).toBe("0");
    expect(el.selectionStart).toBe(30);
    w.unmount();
  });

  /**
   * **入力欄の外を指されたら、その位置に置く**（自由カーソル）。先頭欄へ寄せない。
   *
   * SEU の走査検索（表示モード）がまさにこれ——ホストは見つかった文字列の頭に `IC` を
   * 送るが、表示モードではその桁が保護欄。先頭欄へ寄せると `SEU==>` へ飛んでしまい、
   * どこが見つかったのか分からなくなっていた（利用者の指摘）。ACS は指された桁に置く。
   *
   * 「ホストがカーソルを置かなかった画面」の正規化は protocol 層が済ませている
   * （`session.ts` の `readRequested && !cursorSet` → `cursorToFirstInputField`）ので、
   * ここへ来る「欄の外」はホストがわざと指した場合だけ。
   */
  it("カーソルが入力欄の外なら**寄せずに**その桁へ（欄には focus しない）", async () => {
    const w = mountGrid({ row: 20, col: 1 }); // どの欄にも属さない
    await focusPane(w);
    // 入力欄は掴まない（親がペインへ focus して自由カーソルにする）
    expect(document.activeElement).not.toBeInstanceOf(HTMLInputElement);
    // 親へ「この桁だ」と伝えている（`reconcileFocus` がオーバーレイを出す）
    const cursorEvents = w.findComponent({ name: "ScreenGrid" }).emitted("cursor") ?? [];
    expect(cursorEvents.at(-1)).toEqual([20, 1]);
    w.unmount();
  });
});

/**
 * SEU の走査検索（表示モード）を写した形。
 *
 * ホストは見つかった文字列の頭に `IC` を送る（実機で `row 6, col 10` を確認）。
 * 表示モードではその桁が**保護欄**なので、先頭欄へ寄せると `SEU==>` へ飛び、
 * どこが見つかったのか分からなくなっていた（利用者の指摘）。ACS は指された桁に置く。
 */
describe("SEU の走査検索（表示モード）", () => {
  /** 保護欄（表示モードのソース行） */
  function ro(index: number, row: number, col: number, length: number): Field {
    return { ...fld(index, row, col, length), protected: true };
  }

  function seuSnap() {
    // #1 = SEU==>（唯一の入力欄）、#2 = ソース行（保護）
    return snap([fld(1, 2, 9, 60), ro(2, 6, 9, 60)], { row: 6, col: 10 });
  }

  it("`SEU==>` へ飛ばさない（入力欄を掴まない）", async () => {
    const w = mount(ScreenGrid, {
      props: { snapshot: seuSnap(), focused: true, edits: new Map() },
      attachTo: document.body
    });
    await nextTick();
    await nextTick();
    expect(document.activeElement).not.toBeInstanceOf(HTMLInputElement);
    w.unmount();
  });

  it("ホストが指した桁にカーソルのオーバーレイが出る", async () => {
    const w = mount(ScreenGrid, {
      props: { snapshot: seuSnap(), focused: true, edits: new Map() },
      attachTo: document.body
    });
    await nextTick();
    const style = w.find(".cursor").attributes("style") ?? "";
    // 0 起点: col 10 → 9ch、row 6 → 5 * 1.25em
    expect(style).toContain("left: 9ch");
    expect(style).toContain("top: 6.25em");
    w.unmount();
  });
});
