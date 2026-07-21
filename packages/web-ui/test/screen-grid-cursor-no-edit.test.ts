import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import ScreenGrid from "../src/components/ScreenGrid.vue";
import type { ScreenSnapshot, Cell, Field } from "@as400web/core";

/**
 * **横方向のカーソル移動だけでは欄を「変更（編集）」扱いにしない。**
 *
 * 以前は sync() がカーソル移動でも無条件に `emit("edit")` していたため、欄に入って左右へ
 * 動いただけで edits に載り、送信で MDT が立って行が変更扱いになっていた（SEU で行の色が消える等）。
 * 値が実際に変わったときだけ edit を出す。
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

function snap(field: Field): ScreenSnapshot {
  const cells: Cell[][] = [];
  for (let r = 0; r < 24; r++) {
    const row: Cell[] = [];
    for (let c = 0; c < 80; c++) row.push(cell(" "));
    cells.push(row);
  }
  // 欄の中身 "ABCDE" を row5 col9〜 に置く（表示用。値は field.value）
  "ABCDE".split("").forEach((ch, i) => (cells[5]![9 + i] = cell(ch)));
  return {
    sessionId: "s",
    rows: 24,
    cols: 80,
    cursor: { row: 1, col: 1 },
    keyboardLocked: false,
    cells,
    fields: [field]
  };
}

const FIELD: Field = {
  index: 1,
  row: 6,
  col: 10,
  length: 8,
  protected: false,
  hidden: false,
  numeric: false,
  mdt: false,
  value: "ABCDE"
};

describe("カーソル移動は編集扱いにしない", () => {
  it("End / ArrowLeft / ArrowRight では edit を emit しない", async () => {
    const w = mount(ScreenGrid, { props: { snapshot: snap(FIELD), edits: new Map(), focused: true } });
    const input = w.find("input.grid-input");
    await input.trigger("focus");
    await input.trigger("keydown", { key: "End" });
    await input.trigger("keydown", { key: "ArrowLeft" });
    await input.trigger("keydown", { key: "ArrowRight" });
    await input.trigger("keydown", { key: "Home" });
    // カーソル移動だけ → edit は 1 度も出ない
    expect(w.emitted("edit")).toBeUndefined();
    // cursor（AID 位置追従）は出てよい
    expect(w.emitted("cursor")).toBeDefined();
  });

  it("実際に文字を入力すると edit を emit する", async () => {
    const w = mount(ScreenGrid, { props: { snapshot: snap(FIELD), edits: new Map(), focused: true } });
    const input = w.find("input.grid-input");
    await input.trigger("focus");
    await input.trigger("keydown", { key: "End" });
    await input.trigger("keydown", { key: "X" }); // 末尾に X を追加
    const edits = w.emitted("edit") as [number, string][] | undefined;
    expect(edits).toBeDefined();
    expect(edits!.at(-1)![1]).toBe("ABCDEX");
  });
});
