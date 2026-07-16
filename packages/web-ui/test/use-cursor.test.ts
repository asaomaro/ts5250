import { describe, it, expect } from "vitest";
import { moveCursor, fieldAt, caretInField, roundToDbcsLead, nextWordStart } from "../src/composables/useCursor.js";
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
    expect(fieldAt(5, 10, fields, 80, 24)).toBe(fields[0]); // 先頭桁
    expect(fieldAt(5, 14, fields, 80, 24)).toBe(fields[0]); // 末尾桁
    expect(fieldAt(6, 12, fields, 80, 24)).toBe(fields[2]);
  });

  it("範囲外（末尾+1・別行・隙間）は undefined", () => {
    expect(fieldAt(5, 15, fields, 80, 24)).toBeUndefined(); // col+length は範囲外
    expect(fieldAt(5, 9, fields, 80, 24)).toBeUndefined();
    expect(fieldAt(7, 10, fields, 80, 24)).toBeUndefined();
  });

  it("保護フィールドも命中する（可否判定は呼び出し側）", () => {
    expect(fieldAt(5, 21, fields, 80, 24)).toBe(fields[1]);
  });

  it("行またぎフィールドは折返し先の行でも命中する（コマンド行 (20,7) len=153）", () => {
    const cmd = [field(20, 7, 153)];
    expect(fieldAt(20, 7, cmd, 80, 24)).toBe(cmd[0]); // 先頭
    expect(fieldAt(20, 80, cmd, 80, 24)).toBe(cmd[0]); // 1 行目末尾
    expect(fieldAt(21, 1, cmd, 80, 24)).toBe(cmd[0]); // 折返し先の先頭
    expect(fieldAt(21, 79, cmd, 80, 24)).toBe(cmd[0]); // 折返し先の末尾（74+79=153）
    expect(fieldAt(21, 80, cmd, 80, 24)).toBeUndefined(); // 範囲外
  });
});

describe("useCursor.caretInField", () => {
  const f = field(5, 10, 5);

  it("先頭からの桁オフセットを返す", () => {
    expect(caretInField(f, 5, 10, 80, 24)).toBe(0);
    expect(caretInField(f, 5, 13, 80, 24)).toBe(3);
  });

  it("0〜length にクランプする", () => {
    expect(caretInField(f, 5, 5, 80, 24)).toBe(0); // 手前
    expect(caretInField(f, 5, 100, 80, 24)).toBe(5); // 末尾超過は length
  });

  it("行またぎフィールドは前行までの桁数を加算する", () => {
    const cmd = field(20, 7, 153);
    expect(caretInField(cmd, 20, 7, 80, 24)).toBe(0);
    expect(caretInField(cmd, 20, 80, 80, 24)).toBe(73); // 1 行目末尾
    expect(caretInField(cmd, 21, 1, 80, 24)).toBe(74); // 折返し先の先頭
    expect(caretInField(cmd, 21, 79, 80, 24)).toBe(152); // 最終桁
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

describe("useCursor.nextWordStart", () => {
  // 文字列から 1 行のセル配列を作る（スペース=空白）
  function row(s: string): Cell[] {
    return [...s].map((ch) => ({ ...cell("sbcs"), char: ch }));
  }
  function grid(...lines: string[]): Cell[][] {
    return lines.map(row);
  }

  it("空白から Ctrl+→ で次の語頭へ（TEXT1  ␣  TEXT2 → T of TEXT2）", () => {
    // "TEXT1  TEXT2" : 桁1..5=TEXT1, 桁6-7=空白, 桁8..=TEXT2
    const cells = grid("TEXT1  TEXT2");
    const cols = 12;
    // 空白（桁7）から右 → TEXT2 の T（桁8）
    expect(nextWordStart(cells, { row: 1, col: 7 }, "right", 1, cols)).toEqual({ row: 1, col: 8 });
  });

  it("語中から Ctrl+→ は次の語頭へ（現在の語は飛ばす）", () => {
    const cells = grid("TEXT1  TEXT2");
    // TEXT1 の中（桁3）から右 → TEXT2 の T（桁8）
    expect(nextWordStart(cells, { row: 1, col: 3 }, "right", 1, 12)).toEqual({ row: 1, col: 8 });
  });

  it("Ctrl+← は前の語頭へ（語中なら現在語の先頭）", () => {
    const cells = grid("TEXT1  TEXT2");
    // TEXT2 の中（桁10）から左 → TEXT2 の先頭（桁8）
    expect(nextWordStart(cells, { row: 1, col: 10 }, "left", 1, 12)).toEqual({ row: 1, col: 8 });
    // TEXT2 の先頭（桁8）から左 → 前の語 TEXT1 の先頭（桁1）
    expect(nextWordStart(cells, { row: 1, col: 8 }, "left", 1, 12)).toEqual({ row: 1, col: 1 });
  });

  it("行をまたいで次/前の語頭へ", () => {
    const cells = grid("AAA    ", "   BBB ");
    // 1 行目 AAA の末尾付近（桁3）から右 → 2 行目 BBB の先頭（row2,col4）
    expect(nextWordStart(cells, { row: 1, col: 3 }, "right", 2, 7)).toEqual({ row: 2, col: 4 });
    // 2 行目 BBB 先頭から左 → 1 行目 AAA の先頭
    expect(nextWordStart(cells, { row: 2, col: 4 }, "left", 2, 7)).toEqual({ row: 1, col: 1 });
  });

  it("語が無ければ pos を返す（画面端で停止）", () => {
    const cells = grid("  ABC  ");
    expect(nextWordStart(cells, { row: 1, col: 5 }, "right", 1, 7)).toEqual({ row: 1, col: 5 });
    expect(nextWordStart(cells, { row: 1, col: 2 }, "left", 1, 7)).toEqual({ row: 1, col: 2 });
  });

  it("Ctrl+↑/↓ は同じ列位置で空白をスキップし最も近い非空白セルへ", () => {
    // ABCDEFG / HIJ LMN / OPQXSTU（2 行目の 4 列目は空白）
    const cells = grid("ABCDEFG", "HIJ LMN", "OPQXSTU");
    // x=3 行 4 列（X）から上 → 2 行 4 列は空白なので飛ばし 1 行 4 列 D へ（列は保持）
    expect(nextWordStart(cells, { row: 3, col: 4 }, "up", 3, 7)).toEqual({ row: 1, col: 4 });
    // 1 行 4 列 D から下 → 2 行 4 列 空白を飛ばし 3 行 4 列 X へ
    expect(nextWordStart(cells, { row: 1, col: 4 }, "down", 3, 7)).toEqual({ row: 3, col: 4 });
    // 列 1（全行 A/H/O が埋まる）は隣接行へ 1 つずつ
    expect(nextWordStart(cells, { row: 2, col: 1 }, "up", 3, 7)).toEqual({ row: 1, col: 1 });
    expect(nextWordStart(cells, { row: 2, col: 1 }, "down", 3, 7)).toEqual({ row: 3, col: 1 });
  });

  it("同一列に非空白が無ければ pos を返す（端で停止）", () => {
    // 4 列目は全行空白
    const cells = grid("ABC ", "HIJ ", "OPQ ");
    expect(nextWordStart(cells, { row: 3, col: 4 }, "up", 3, 4)).toEqual({ row: 3, col: 4 });
    expect(nextWordStart(cells, { row: 1, col: 4 }, "down", 3, 4)).toEqual({ row: 1, col: 4 });
  });

  it("全角後半（dbcs-tail）は語頭にしない（lead を語頭とする）", () => {
    // 桁1=空白, 桁2=dbcs-lead, 桁3=dbcs-tail, 桁4=空白
    const cells: Cell[][] = [[{ ...cell("sbcs"), char: " " }, { ...cell("dbcs-lead"), char: "日" }, { ...cell("dbcs-tail"), char: "" }, { ...cell("sbcs"), char: " " }]];
    // 桁1 から右 → lead（桁2）。tail（桁3）は語頭にしない
    expect(nextWordStart(cells, { row: 1, col: 1 }, "right", 1, 4)).toEqual({ row: 1, col: 2 });
  });
});
