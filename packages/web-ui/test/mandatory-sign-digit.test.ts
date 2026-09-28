import { describe, it, expect } from "vitest";
import type { Field } from "@ts5250/tn5250";
import { findFieldViolation } from "../src/composables/mandatoryCheck.js";

/**
 * **符号付き数値の欄の MF・自己点検は符号の桁を数えない**（`20260928-mandatory-sign-digit`）。ACS `Field5250.isFieldFull`・`isAllNulls`・`checkModulusField` は
 * 符号付き数値の欄で `endPos - 1` までを見る（HLLAPI の `hllapi-leave-check.ts` も同じ）。欄は長さ 6（数字 5 桁＋符号の桁）
 */
function fld(o: Partial<Field>): Field {
  return { index: 1, row: 5, col: 10, length: 6, protected: false, hidden: false, numeric: true, mdt: false, value: "", signedNumeric: true, ...o };
}

describe("符号付き数値の MF", () => {
  const f = fld({ adjust: "mandatory-fill" });
  it("数字 5 桁なら満杯（符号の桁が空でも・`-` でも）", () => {
    expect(findFieldViolation(f, new Map([[1, "12345"]]))).toBeUndefined();
    expect(findFieldViolation(f, new Map([[1, "12345 "]]))).toBeUndefined();
    expect(findFieldViolation(f, new Map([[1, "12345-"]]))).toBeUndefined();
  });
  it("数字 3 桁なら途中まで（符号の桁の `-` は中身に数えない）", () => {
    expect(findFieldViolation(f, new Map([[1, "123"]]))?.reason).toBe("mandatory-fill");
    expect(findFieldViolation(f, new Map([[1, "123  -"]]))?.reason).toBe("mandatory-fill");
  });
  it("符号の桁だけ（`-`）は空とみなす", () => {
    expect(findFieldViolation(f, new Map([[1, "     -"]]))).toBeUndefined();
  });
});

describe("符号付き数値の自己点検", () => {
  const f = fld({ selfCheck: "mod10" });
  it("符号の桁の手前を検査桁として検算する（`-` 付きでも）", () => {
    expect(findFieldViolation(f, new Map([[1, "12302"]]))).toBeUndefined(); // 1230 の mod10 検査桁は 2
    expect(findFieldViolation(f, new Map([[1, "12302-"]]))).toBeUndefined();
    expect(findFieldViolation(f, new Map([[1, "12305-"]]))?.reason).toBe("self-check");
  });
});
