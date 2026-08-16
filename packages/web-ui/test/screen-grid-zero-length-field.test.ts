import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import ScreenGrid from "../src/components/ScreenGrid.vue";
import type { ScreenSnapshot, Cell, Field } from "@ts5250/tn5250";

/**
 * **長さ 0 の欄で描画が止まらないこと。**
 *
 * 3270 は**属性桁が隣接すると中身の無い欄**ができる（IBM i の 3270 変換で実際に出た。
 * pub400 のサインオン画面は 52 欄中 13 欄が長さ 0）。5250 では起きない形なので、
 * 描画側は**幅 0 のスライスを想定していなかった**——桁を `c += width` で進めるため、
 * **同じ桁を回り続けて segs が無限に伸び、ブラウザのタブごと落ちた**。
 *
 * 実ブラウザ（Playwright）で pub400 に繋いで踏んだ。ここでは同じ形の画面を組んで固定する。
 */
const cell = (char: string): Cell =>
  ({
    char, kind: "sbcs", color: "green", reverse: false, underline: false,
    blink: false, columnSeparator: false, nonDisplay: false
  }) as Cell;

function snapshot(fields: Field[]): ScreenSnapshot {
  const cells: Cell[][] = [];
  for (let r = 0; r < 24; r++) {
    const row: Cell[] = [];
    for (let c = 0; c < 80; c++) row.push(cell(r === 0 && c < 4 ? "ABCD"[c]! : " "));
    cells.push(row);
  }
  return {
    sessionId: "s", rows: 24, cols: 80, cursor: { row: 1, col: 1 },
    keyboardLocked: false, cells, fields
  } as ScreenSnapshot;
}

const field = (index: number, row: number, col: number, length: number): Field =>
  ({ index, row, col, length, protected: false, hidden: false, numeric: false, mdt: false, value: "" }) as Field;

describe("長さ 0 の欄があっても描ける", () => {
  it("**幅 0 のスライスで桁が止まらない**（無限ループでタブが落ちない）", () => {
    // 行末に長さ 0 の欄、その後ろに普通の欄——pub400 のサインオン画面と同じ形
    const w = mount(ScreenGrid, {
      props: {
        snapshot: snapshot([field(1, 9, 80, 0), field(2, 10, 5, 6), field(3, 11, 80, 0)]),
        edits: new Map(),
        focused: true
      }
    });
    expect(w.find(".grid").exists()).toBe(true);
    // 長さ 0 の欄は入力欄を作らない。普通の欄だけが出る
    expect(w.findAll("input.grid-input").length).toBe(1);
  });

  it("**長さ 0 の欄しか無くても描ける**", () => {
    const w = mount(ScreenGrid, {
      props: { snapshot: snapshot([field(1, 1, 80, 0)]), edits: new Map(), focused: true }
    });
    expect(w.find(".grid").exists()).toBe(true);
    expect(w.text()).toContain("ABCD");
  });
});
