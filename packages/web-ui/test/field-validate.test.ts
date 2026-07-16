import { describe, it, expect } from "vitest";
import { acceptsChar } from "../src/composables/fieldValidate.js";
import type { Field } from "@as400web/core";

function fld(o: Partial<Field>): Field {
  return { index: 1, row: 1, col: 1, length: 10, protected: false, hidden: false, numeric: false, mdt: false, value: "", ...o };
}

describe("acceptsChar フィールド型ごとの入力ルール", () => {
  it("数値: 数字・小数点・符号を許可し、英字と全角を拒否", () => {
    const f = fld({ numeric: true });
    for (const ch of ["0", "9", ".", "-", "+"]) expect(acceptsChar(f, ch)).toBe(true);
    for (const ch of ["A", "z"]) expect(acceptsChar(f, ch)).toBe(false); // 英字不可
    expect(acceptsChar(f, "日")).toBe(false); // 全角不可
  });

  it("A（SBCS/英数字）: 半角を許可し、DBCS(全角)を拒否", () => {
    const f = fld({}); // dbcsType 無し = SBCS
    expect(acceptsChar(f, "A")).toBe(true);
    expect(acceptsChar(f, "1")).toBe(true);
    expect(acceptsChar(f, "日")).toBe(false); // ← A は DBCS を入力できない
    expect(acceptsChar(f, "あ")).toBe(false);
  });

  it("O（open）: SBCS も DBCS も許可", () => {
    const f = fld({ dbcsType: "open" });
    expect(acceptsChar(f, "A")).toBe(true);
    expect(acceptsChar(f, "日")).toBe(true);
  });

  it("J（pure DBCS）: DBCS を許可し、SBCS を拒否", () => {
    const f = fld({ dbcsType: "pure" });
    expect(acceptsChar(f, "日")).toBe(true);
    expect(acceptsChar(f, "あ")).toBe(true);
    expect(acceptsChar(f, "A")).toBe(false); // ← J は SBCS を入力できない
    expect(acceptsChar(f, "1")).toBe(false);
  });

  it("either: SBCS も DBCS も許可", () => {
    const f = fld({ dbcsType: "either" });
    expect(acceptsChar(f, "A")).toBe(true);
    expect(acceptsChar(f, "日")).toBe(true);
  });
});
