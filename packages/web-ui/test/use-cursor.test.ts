import { describe, it, expect } from "vitest";
import { moveCursor, fieldAt, caretInField, roundToDbcsLead } from "../src/composables/useCursor.js";
import type { Cell, Field } from "@as400web/core";

function field(row: number, col: number, length: number, protectedField = false): Field {
  return { index: 1, row, col, length, protected: protectedField, hidden: false, numeric: false, mdt: false, value: "" };
}

function cell(kind: Cell["kind"]): Cell {
  return {
    char: " ",
    kind,
    color: "green",
    reverse: false,
    underline: false,
    blink: false,
    columnSeparator: false,
    nonDisplay: false
  };
}

describe("useCursor.moveCursor", () => {
  const R = 24;
  const C = 80;

  it("左右で 1 桁移動する", () => {
    expect(moveCursor({ row: 5, col: 10 }, "right", R, C)).toEqual({ row: 5, col: 11 });
    expect(moveCursor({ row: 5, col: 10 }, "left", R, C)).toEqual({ row: 5, col: 9 });
  });

  it("行末で right は次行先頭へ、行頭で left は前行末尾へ（行送り/戻し）", () => {
    expect(moveCursor({ row: 5, col: C }, "right", R, C)).toEqual({ row: 6, col: 1 });
    expect(moveCursor({ row: 5, col: 1 }, "left", R, C)).toEqual({ row: 4, col: C });
  });

  it("画面右下端の right・左上端の left はクランプ（外へ出ない）", () => {
    expect(moveCursor({ row: R, col: C }, "right", R, C)).toEqual({ row: R, col: C });
    expect(moveCursor({ row: 1, col: 1 }, "left", R, C)).toEqual({ row: 1, col: 1 });
  });

  it("上下は同じ桁で行移動、画面端はクランプ", () => {
    expect(moveCursor({ row: 5, col: 10 }, "up", R, C)).toEqual({ row: 4, col: 10 });
    expect(moveCursor({ row: 5, col: 10 }, "down", R, C)).toEqual({ row: 6, col: 10 });
    expect(moveCursor({ row: 1, col: 10 }, "up", R, C)).toEqual({ row: 1, col: 10 });
    expect(moveCursor({ row: R, col: 10 }, "down", R, C)).toEqual({ row: R, col: 10 });
  });
});

describe("useCursor.fieldAt", () => {
  const fields = [field(5, 10, 5), field(5, 20, 3, true), field(6, 10, 5)];

  it("フィールド範囲内の (row,col) を返す（先頭〜末尾）", () => {
    expect(fieldAt(5, 10, fields)).toBe(fields[0]); // 先頭桁
    expect(fieldAt(5, 14, fields)).toBe(fields[0]); // 末尾桁
    expect(fieldAt(6, 12, fields)).toBe(fields[2]);
  });

  it("範囲外（末尾+1・別行・隙間）は undefined", () => {
    expect(fieldAt(5, 15, fields)).toBeUndefined(); // col+length は範囲外
    expect(fieldAt(5, 9, fields)).toBeUndefined();
    expect(fieldAt(7, 10, fields)).toBeUndefined();
  });

  it("保護フィールドも命中する（可否判定は呼び出し側）", () => {
    expect(fieldAt(5, 21, fields)).toBe(fields[1]);
  });
});

describe("useCursor.caretInField", () => {
  const f = field(5, 10, 5);

  it("先頭からの桁オフセットを返す", () => {
    expect(caretInField(f, 10)).toBe(0);
    expect(caretInField(f, 13)).toBe(3);
  });

  it("0〜length にクランプする", () => {
    expect(caretInField(f, 5)).toBe(0); // 手前
    expect(caretInField(f, 100)).toBe(5); // 末尾超過は length
  });
});

describe("useCursor.roundToDbcsLead", () => {
  // row1: [sbcs, dbcs-lead, dbcs-tail, sbcs]
  const cells: Cell[][] = [[cell("sbcs"), cell("dbcs-lead"), cell("dbcs-tail"), cell("sbcs")]];

  it("dbcs-tail 桁は前半（lead）へ丸める", () => {
    expect(roundToDbcsLead({ row: 1, col: 3 }, cells)).toEqual({ row: 1, col: 2 });
  });

  it("sbcs・dbcs-lead はそのまま", () => {
    expect(roundToDbcsLead({ row: 1, col: 1 }, cells)).toEqual({ row: 1, col: 1 });
    expect(roundToDbcsLead({ row: 1, col: 2 }, cells)).toEqual({ row: 1, col: 2 });
  });

  it("範囲外はそのまま返す", () => {
    expect(roundToDbcsLead({ row: 9, col: 9 }, cells)).toEqual({ row: 9, col: 9 });
  });
});
