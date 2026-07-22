import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import ScreenGrid from "../src/components/ScreenGrid.vue";
import type { ScreenSnapshot, Cell, Field } from "@as400web/core";

/**
 * **表示できない SBCS は半角スペースで出す（ACS と同じ）。**
 *
 * EBCDIC の SBCS 表にはマップの無いバイトがあり、コーデックはそこを U+FFFD で返す。
 * そのまま出すと多くのフォントで U+FFFD が全角幅になり、1 桁のはずが 2 桁を占めて
 * その行の後続がすべて右へずれる。表示コードページの切り替え（930 カナ表と 1027 表で
 * 未定義バイトの集合が違う）で実際に現れた。
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

function snapWith(chars: string[]): ScreenSnapshot {
  const cells: Cell[][] = [];
  for (let r = 0; r < 24; r++) {
    const row: Cell[] = [];
    for (let c = 0; c < 80; c++) row.push(cell(" "));
    cells.push(row);
  }
  chars.forEach((ch, i) => {
    cells[0]![i] = cell(ch);
  });
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

describe("表示できない SBCS（U+FFFD）", () => {
  it("画面テキストでは半角スペースになる（桁がずれない）", () => {
    const w = mount(ScreenGrid, {
      props: { snapshot: snapWith(["A", "�", "B"]), edits: new Map(), focused: true }
    });
    const text = w.findAll(".grid-row")[0]!.text();
    expect(text).not.toContain("�");
    expect(text.startsWith("A B")).toBe(true);
  });

  it("入力欄の中でも半角スペースになる", () => {
    const snapshot = snapWith(["A", "�", "B"]);
    const field: Field = {
      index: 1,
      row: 1,
      col: 1,
      length: 3,
      protected: true,
      hidden: false,
      numeric: false,
      mdt: false,
      value: "A�B"
    };
    snapshot.fields = [field];
    const w = mount(ScreenGrid, { props: { snapshot, edits: new Map(), focused: true } });
    const v = (w.find("input.grid-input").element as HTMLInputElement).value;
    expect(v).not.toContain("�");
    expect(v.startsWith("A B")).toBe(true);
  });
});
