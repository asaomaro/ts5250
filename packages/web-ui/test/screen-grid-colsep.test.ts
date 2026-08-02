import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import ScreenGrid from "../src/components/ScreenGrid.vue";
import type { ScreenSnapshot, Cell } from "@ts5250/tn5250";

/**
 * **DSPATR(CS)（桁区切り）を画面に出す。**
 *
 * core（`screen/attributes.ts`）は属性バイト 0x30–0x33 等から `columnSeparator` を
 * 正しく解析してセルに持っていたが、描画側（`cellClass`）が underline / reverse / blink だけを
 * CSS クラス化し、**`columnSeparator` を完全に素通ししていた**。
 * そのため DDS(DSPF) が `DSPATR(CS)` で描いた区切り線が Web UI に一切出なかった
 * （実機環境からの調査報告 dspf-report (1)）。
 */
function cell(char: string, extra: Partial<Cell> = {}): Cell {
  return {
    char, kind: "sbcs", color: "green", reverse: false, underline: false,
    blink: false, columnSeparator: false, nonDisplay: false, ...extra
  } as Cell;
}

function snapWith(cells: Cell[][]): ScreenSnapshot {
  return {
    sessionId: "s", rows: 24, cols: 80, cursor: { row: 1, col: 1 },
    keyboardLocked: false, cells, fields: []
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

describe("DSPATR(CS) 桁区切りの描画", () => {
  it("columnSeparator のセルに a-colsep が付く", () => {
    const cells = blank();
    cells[3]![10] = cell("A", { columnSeparator: true });
    const w = mount(ScreenGrid, { props: { snapshot: snapWith(cells), edits: new Map(), focused: true } });
    expect(w.html()).toContain("a-colsep");
  });

  it("columnSeparator の無い画面には a-colsep が出ない", () => {
    const w = mount(ScreenGrid, { props: { snapshot: snapWith(blank()), edits: new Map(), focused: true } });
    expect(w.html()).not.toContain("a-colsep");
  });

  it("他の属性と併用できる（下線・反転と同じランに載る）", () => {
    const cells = blank();
    cells[3]![10] = cell("A", { columnSeparator: true, underline: true, color: "red" });
    const w = mount(ScreenGrid, { props: { snapshot: snapWith(cells), edits: new Map(), focused: true } });
    const span = w.findAll("span.grid-span").find((s) => s.classes().includes("a-colsep"));
    expect(span).toBeDefined();
    expect(span!.classes()).toContain("a-underline");
    expect(span!.classes()).toContain("c-red");
  });

  /**
   * **黄・青緑は桁区切りビットを落とす。**
   *
   * 5250 の属性バイト表（SC30-3533）には黄・青緑を「修飾なし」で表す値が無く、
   * `COLOR(YLW)` を単体で指定しただけでも桁区切りビット付きの値にコンパイルされる
   * （属性バイトだけでは DSPATR(CS) を本当に頼んだのか区別できない）。窓の見出し・枠
   * では既にこれを踏まえて桁区切りを出さないようにしていたが、通常のフィールドには
   * 適用しておらず、黄字の欄の頭に意図しない縦棒が出ていた（利用者報告で判明）。
   */
  it("黄地のセルには columnSeparator が立っていても a-colsep を出さない", () => {
    const cells = blank();
    cells[3]![10] = cell("A", { columnSeparator: true, color: "yellow" });
    const w = mount(ScreenGrid, { props: { snapshot: snapWith(cells), edits: new Map(), focused: true } });
    expect(w.html()).not.toContain("a-colsep");
  });

  it("青緑地のセルには columnSeparator が立っていても a-colsep を出さない", () => {
    const cells = blank();
    cells[3]![10] = cell("A", { columnSeparator: true, color: "turquoise" });
    const w = mount(ScreenGrid, { props: { snapshot: snapWith(cells), edits: new Map(), focused: true } });
    expect(w.html()).not.toContain("a-colsep");
  });
});
