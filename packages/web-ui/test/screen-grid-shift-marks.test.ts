import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import ScreenGrid from "../src/components/ScreenGrid.vue";
import type { ScreenSnapshot, Cell, Field } from "@as400web/core";

/**
 * **FCW で DBCS 宣言されていない欄でも SO/SI マークを出す。**
 *
 * ホストは出力専用の欄に FCW を付けないことがある（PDM のテキスト列など）。この欄は
 * `Field.dbcsType` が undefined なので DBCS 用の描画経路に入らず、core の `fieldValue` が
 * SO/SI を空白に潰した値をそのまま表示していた。結果、SO/SI マーク表示（ACS の Ctrl+F 相当）を
 * ON にしても `{ }` が出ず、空白のままだった——同じ画面の定数（見出し等）には出ているのに。
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

/** row 6 / col 10 から 10 桁の欄に「SO 取引 SI」を置く（FCW 無し＝dbcsType undefined） */
function snapshotWithShiftCells(): ScreenSnapshot {
  const cells: Cell[][] = [];
  for (let r = 0; r < 24; r++) {
    const row: Cell[] = [];
    for (let c = 0; c < 80; c++) row.push(cell(" "));
    cells.push(row);
  }
  const row = cells[5]!;
  row[9] = cell(" ", { kind: "so" });
  row[10] = cell("取", { kind: "dbcs-lead" });
  row[11] = cell("", { kind: "dbcs-tail" });
  row[12] = cell("引", { kind: "dbcs-lead" });
  row[13] = cell("", { kind: "dbcs-tail" });
  row[14] = cell(" ", { kind: "si" });
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

/** core の fieldValue は SO/SI を空白として返す（欄は DBCS 宣言されていない） */
const FIELD: Field = {
  index: 1,
  row: 6,
  col: 10,
  length: 10,
  protected: true,
  hidden: false,
  numeric: false,
  mdt: false,
  value: " 取引 "
};

function inputValueOf(showShiftMarks: boolean): string {
  const snapshot = snapshotWithShiftCells();
  snapshot.fields = [FIELD];
  const w = mount(ScreenGrid, {
    props: { snapshot, edits: new Map(), focused: true, showShiftMarks }
  });
  return (w.find("input.grid-input").element as HTMLInputElement).value;
}

describe("SO/SI マーク表示（DBCS 宣言の無い欄）", () => {
  it("マーク表示 ON なら欄の中でも { } が出る", () => {
    expect(inputValueOf(true).startsWith("{取引}")).toBe(true);
  });

  it("マーク表示 OFF なら従来どおり空白（桁は保たれる）", () => {
    expect(inputValueOf(false).startsWith(" 取引 ")).toBe(true);
  });

  it("欄長ぶんの桁が保たれる（全角は 2 桁ぶんを 1 文字で占める）", () => {
    // SO(1) + 全角 2 文字(1 文字ずつ・4 桁) + SI(1) + 残り 4 桁の空白 = 文字数 10 - tail 2 = 8
    expect(inputValueOf(true)).toHaveLength(8);
  });
});
