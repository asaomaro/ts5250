import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import ScreenGrid from "../src/components/ScreenGrid.vue";
import type { ScreenSnapshot, Cell, Field } from "@ts5250/tn5250";

/**
 * **DSPATR(CS)（桁区切り）を ACS と同じく桁ごとに描く。**
 *
 * 経緯:
 *   1. core は `columnSeparator` を解析していたが、描画側が素通ししていた（dspf-report (1)）
 *   2. 文字ランに `border-left` を付けて出すようにした——が、**連なりの頭に 1 本出るだけ**で
 *      桁の区切りにならず、黄字の欄の頭に「意図しない縦棒」として見えた（利用者報告）。
 *      その対処で黄・青緑を除外していた
 *   3. ACS の実装（`ScreenText`）を読むと、桁区切りは**各桁の境目**に描き、既定は**点**。
 *      黄・青緑（0x30–0x37）も対象で、下線付きの入力欄に桁ごとの点が並ぶ
 *      （利用者の記憶「入力可能エリアに 1 桁ずつ下線に . が付いて桁が分かる」）。
 *      ACS に合わせる（利用者の判断）
 */
function cell(char: string, extra: Partial<Cell> = {}): Cell {
  return {
    char, kind: "sbcs", color: "green", reverse: false, underline: false,
    blink: false, columnSeparator: false, nonDisplay: false, ...extra
  } as Cell;
}

function snapWith(cells: Cell[][], fields: Field[] = []): ScreenSnapshot {
  return {
    sessionId: "s", rows: 24, cols: 80, cursor: { row: 1, col: 1 },
    keyboardLocked: false, cells, fields
  } as ScreenSnapshot;
}

function blank(): Cell[][] {
  const rows: Cell[][] = [];
  for (let r = 0; r < 24; r++) {
    const row: Cell[] = [];
    for (let c = 0; c < 80; c++) row.push(cell(" "));
    rows.push(row);
  }
  return rows;
}

/** 4 行目の 11〜13 桁を桁区切りにした画面 */
function withRun(extra: Partial<Cell> = {}): Cell[][] {
  const cells = blank();
  for (const c of [10, 11, 12]) cells[3]![c] = cell("A", { columnSeparator: true, ...extra });
  return cells;
}

const styles = (w: ReturnType<typeof mount>) => w.findAll(".colsep").map((d) => d.attributes("style") ?? "");

describe("DSPATR(CS) 桁区切りの描画", () => {
  it("連なりの頭の左端と各桁の右端に 1 本ずつ（3 桁なら 4 本）、既定は点", () => {
    const w = mount(ScreenGrid, { props: { snapshot: snapWith(withRun()), edits: new Map(), focused: true } });
    const ticks = w.findAll(".colsep");
    expect(ticks).toHaveLength(4);
    expect(ticks.every((t) => t.classes().includes("colsep-dot"))).toBe(true);
    // 11 桁目の左端＝10ch から 13 桁目の右端＝13ch まで
    expect(styles(w).map((s) => /left: ([\d.]+)ch/.exec(s)?.[1])).toEqual(["10", "11", "12", "13"]);
    // 点は行の下端（4 行目の下端＝5em）から 4px 上に置く
    expect(styles(w)[0]).toContain("calc(5em - 4px)");
    w.unmount();
  });

  it("線は行の上端から引く", () => {
    const w = mount(ScreenGrid, {
      props: { snapshot: snapWith(withRun()), edits: new Map(), focused: true, colSep: "line" }
    });
    expect(w.findAll(".colsep.colsep-line")).toHaveLength(4);
    expect(styles(w)[0]).toContain("top: 3.75em");
    w.unmount();
  });

  it("オフなら描かない", () => {
    const w = mount(ScreenGrid, {
      props: { snapshot: snapWith(withRun()), edits: new Map(), focused: true, colSep: "off" }
    });
    expect(w.find(".colsep").exists()).toBe(false);
    w.unmount();
  });

  it("桁区切りの無い画面には描かない", () => {
    const w = mount(ScreenGrid, { props: { snapshot: snapWith(blank()), edits: new Map(), focused: true } });
    expect(w.find(".colsep").exists()).toBe(false);
    w.unmount();
  });

  it("黄・青緑でも描く（ACS は 0x30–0x37 すべてに点を打つ）", () => {
    for (const color of ["yellow", "turquoise"] as const) {
      const w = mount(ScreenGrid, {
        props: { snapshot: snapWith(withRun({ color })), edits: new Map(), focused: true }
      });
      expect(w.findAll(".colsep"), color).toHaveLength(4);
      w.unmount();
    }
  });

  it("入力欄の上にも描く（下線の入力欄に桁ごとの点が並ぶ）", () => {
    const cells = withRun({ underline: true, color: "turquoise" });
    const fields: Field[] = [
      { index: 1, row: 4, col: 11, length: 3, protected: false, hidden: false, numeric: false, mdt: false, value: "" }
    ];
    const w = mount(ScreenGrid, { props: { snapshot: snapWith(cells, fields), edits: new Map(), focused: true } });
    expect(w.find("input.grid-input").exists()).toBe(true);
    expect(w.findAll(".colsep")).toHaveLength(4);
    w.unmount();
  });

  /**
   * **文字ランに線を付けない。** 付けると連なりの頭に 1 本だけ出る描き方に戻るうえ、
   * border の 1px ぶん以降の桁が右へずれる。ランは色・下線など文字の属性だけで切る。
   */
  it("文字ランと入力欄には桁区切りの class を付けない（ランも桁区切りで割らない）", () => {
    const cells = withRun({ underline: true, color: "red" });
    cells[3]![13] = cell("B", { underline: true, color: "red" }); // 桁区切りだけ違う隣の桁
    const w = mount(ScreenGrid, { props: { snapshot: snapWith(cells), edits: new Map(), focused: true } });
    expect(w.html()).not.toContain("a-colsep");
    const run = w.findAll("span.grid-span").find((s) => s.text() === "AAAB");
    expect(run, "桁区切りの有無でランが割れている").toBeDefined();
    expect(run!.classes()).toEqual(expect.arrayContaining(["c-red", "a-underline"]));
    w.unmount();
  });
});
