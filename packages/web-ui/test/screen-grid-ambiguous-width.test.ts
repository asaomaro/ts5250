import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import ScreenGrid from "../src/components/ScreenGrid.vue";
import type { ScreenSnapshot, Cell } from "@as400web/core";

/**
 * **East Asian Width が Ambiguous な DBCS 文字は 2 桁幅の箱で描く。**
 *
 * ホストが DBCS（2 桁）で描いた文字でも、Unicode の符号位置が Ambiguous（U+2212 '−'・
 * U+2010 '‐'・罫線・ギリシャ等）だと欧文等幅フォントは 1 桁で描く。素のテキストのまま
 * 流すとその行の以降の桁が左へ 1 桁ずれる（PDM の F1 ヘルプ「オプション−ヘルプ」の
 * 右端の枠がずれた）。かな・漢字・全角形は従来どおりランに混ぜる（DOM を増やさない）。
 */
function cell(char: string, extra: Partial<Cell> = {}): Cell {
  return {
    char,
    kind: "sbcs",
    color: "green",
    reverse: false,
    underline: false,
    blink: false,
    columnSeparator: false,
    nonDisplay: false,
    ...extra
  };
}

function blankScreen(): ScreenSnapshot {
  const cells: Cell[][] = [];
  for (let r = 0; r < 24; r++) {
    const row: Cell[] = [];
    for (let c = 0; c < 80; c++) row.push(cell(" "));
    cells.push(row);
  }
  return {
    sessionId: "s",
    rows: 24,
    cols: 80,
    cursor: { row: 1, col: 1 },
    keyboardLocked: false,
    cells,
    fields: []
  };
}

/** row 1 col 1 から「ア」＋対象文字＋「イ」を DBCS で置く */
function withDbcs(char: string): ScreenSnapshot {
  const snap = blankScreen();
  const row = snap.cells[0]!;
  row[0] = cell("ア", { kind: "dbcs-lead" });
  row[1] = cell("", { kind: "dbcs-tail" });
  row[2] = cell(char, { kind: "dbcs-lead" });
  row[3] = cell("", { kind: "dbcs-tail" });
  row[4] = cell("イ", { kind: "dbcs-lead" });
  row[5] = cell("", { kind: "dbcs-tail" });
  return snap;
}

function mountGrid(snap: ScreenSnapshot) {
  return mount(ScreenGrid, {
    props: { snapshot: snap, edits: new Map<number, string>(), focused: false }
  });
}

describe("Ambiguous 幅の DBCS 文字の桁保証", () => {
  it("U+FF0D のような確実な全角はランのまま（箱に入れない）", () => {
    const w = mountGrid(withDbcs("－"));
    expect(w.findAll(".wide-cell")).toHaveLength(0);
    expect(w.find(".grid-row").text()).toContain("ア－イ");
  });

  it("U+2212 '−'（Ambiguous）は 2ch 幅の箱に入れて桁を保証する", () => {
    const w = mountGrid(withDbcs("−"));
    const boxes = w.findAll(".wide-cell");
    expect(boxes).toHaveLength(1);
    expect(boxes[0]!.text()).toBe("−");
    // 前後のかなは従来どおりランのまま
    expect(w.find(".grid-row").text()).toContain("ア");
    expect(w.find(".grid-row").text()).toContain("イ");
  });

  it("U+2010 '‐'・罫線・ギリシャ文字も箱に入れる", () => {
    for (const ch of ["‐", "─", "α", "①"]) {
      const boxes = mountGrid(withDbcs(ch)).findAll(".wide-cell");
      expect(boxes.map((b) => b.text())).toEqual([ch]);
    }
  });

  it("箱にも属性クラスが付く（下線・反転が 2 桁ぶん出る）", () => {
    const snap = withDbcs("−");
    const row = snap.cells[0]!;
    row[2] = cell("−", { kind: "dbcs-lead", underline: true });
    row[3] = cell("", { kind: "dbcs-tail", underline: true });
    const box = mountGrid(snap).find(".wide-cell");
    expect(box.classes()).toContain("a-underline");
  });
});
