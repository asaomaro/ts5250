import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import ScreenGrid from "../src/components/ScreenGrid.vue";
import type { ScreenSnapshot, Cell, Field } from "@as400web/core";

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

  it("カーソルが入力欄の外なら先頭欄へ寄せる（従来どおり）", async () => {
    const w = mountGrid({ row: 20, col: 1 }); // どの欄にも属さない
    await focusPane(w);
    const el = document.activeElement as HTMLInputElement;
    expect(el.dataset["fieldIndex"]).toBe("1");
    expect(el.selectionStart).toBe(0);
    w.unmount();
  });
});
