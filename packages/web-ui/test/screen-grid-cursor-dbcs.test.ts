import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import ScreenGrid from "../src/components/ScreenGrid.vue";
import type { Cell, ScreenSnapshot } from "@ts5250/tn5250";

/**
 * **全角の上ではブロックカーソルも 2 桁ぶんを覆う（ACS 準拠）。**
 *
 * 5250 の全角は lead（前半）＋ tail（後半）の 2 桁を占める。カーソルの移動は既に
 * **文字単位**（1 桁ずつではない）なのに、覆う幅が 1 桁のままだと
 * 「文字の左半分にカーソルが載っている」ように見え、動きと見た目が食い違う。
 * ACS は DBCS 1 文字ぜんぶにカーソルを当てる。
 *
 * tail に載ったときは lead から覆う（同じ 1 文字なので見え方を変えない）。
 * **対を失った全角は表示自体が 1 桁**（`screen-grid-dbcs-orphan.test.ts`）なので、
 * カーソルも 1 桁に留める——ここを 2 桁にすると隣の桁へはみ出す。
 */

const COLS = 20;

function cell(over: Partial<Cell> = {}): Cell {
  return {
    char: " ",
    kind: "sbcs",
    color: "green",
    reverse: false,
    underline: false,
    blink: false,
    columnSeparator: false,
    nonDisplay: false,
    ...over
  } as Cell;
}

function snapOf(first: Cell[], cursor: { row: number; col: number }): ScreenSnapshot {
  const row = [...first];
  while (row.length < COLS) row.push(cell());
  const blank = Array.from({ length: COLS }, () => cell());
  return {
    sessionId: "s",
    rows: 2,
    cols: COLS,
    cursor,
    keyboardLocked: false,
    cells: [row.slice(0, COLS), blank],
    fields: []
  } as unknown as ScreenSnapshot;
}

/** ブロックカーソルの inline style（入力欄が無い画面なので必ず出る） */
function cursorStyle(first: Cell[], cursor: { row: number; col: number }): CSSStyleDeclaration {
  const w = mount(ScreenGrid, {
    props: { snapshot: snapOf(first, cursor), edits: new Map(), focused: false, busy: false, cursor }
  });
  const el = w.element.querySelector(".cursor");
  expect(el, "ブロックカーソルが描かれていない").not.toBeNull();
  return (el as HTMLElement).style;
}

const DBCS = [cell({ char: "あ", kind: "dbcs-lead" }), cell({ char: "", kind: "dbcs-tail" }), cell({ char: "A" })];

describe("全角の上のブロックカーソル", () => {
  it("lead に載ると 2 桁ぶんを覆う", () => {
    const s = cursorStyle(DBCS, { row: 1, col: 1 });
    expect(s.width).toBe("2ch");
    expect(s.left).toBe("0ch");
  });

  it("tail に載っても lead から 2 桁ぶんを覆う（同じ 1 文字なので見え方を変えない）", () => {
    const s = cursorStyle(DBCS, { row: 1, col: 2 });
    expect(s.width).toBe("2ch");
    expect(s.left).toBe("0ch");
  });

  it("半角の上では 1 桁のまま", () => {
    const s = cursorStyle(DBCS, { row: 1, col: 3 });
    expect(s.width).toBe("1ch");
    expect(s.left).toBe("2ch");
  });

  it("対を失った全角は 1 桁のまま（表示が 1 桁なので隣へはみ出さない）", () => {
    const orphanLead = [cell({ char: "あ", kind: "dbcs-lead" }), cell({ kind: "attr" })];
    expect(cursorStyle(orphanLead, { row: 1, col: 1 }).width).toBe("1ch");
    const orphanTail = [cell({ kind: "attr" }), cell({ char: "", kind: "dbcs-tail" })];
    expect(cursorStyle(orphanTail, { row: 1, col: 2 }).width).toBe("1ch");
  });
});
