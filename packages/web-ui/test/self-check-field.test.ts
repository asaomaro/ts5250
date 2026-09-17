import { describe, it, expect } from "vitest";
import type { Field } from "@ts5250/tn5250";
import { findMandatoryViolation } from "../src/composables/mandatoryCheck.js";
import { rejectReason } from "../src/composables/fieldValidate.js";
import { MSG_BY_REASON, MSG_SELF_CHECK } from "../src/composables/opMessages.js";

/**
 * **自己点検欄（DDS の `CHECK(M10)` / `CHECK(M11)`）は送信前に検算して止める**（ACS 準拠）。
 *
 * ホストはこれを検証しない——端末が止めなければ検査桁の合わない値がそのまま業務に届く
 * （`MANDATORY_ENTER` / `MANDATORY_FILL` と同じ性質なので、同じ送信前検査に載せている）。
 * 検算そのものは core（`selfCheckDigitOk`）にあり、ここでは「いつ止めるか」を固定する。
 */
function fld(o: Partial<Field>): Field {
  return {
    index: 1, row: 5, col: 10, length: 6,
    protected: false, hidden: false, numeric: false, mdt: false, value: "",
    ...o
  };
}
const noEdits = new Map<number, string>();

describe("送信前の自己点検（findMandatoryViolation）", () => {
  it("mod10 の検査桁が合わなければ self-check で止める", () => {
    const f = fld({ selfCheck: "mod10" });
    expect(findMandatoryViolation([f], new Map([[1, "1234"]]))).toEqual({ field: f, reason: "self-check" });
    expect(findMandatoryViolation([f], new Map([[1, "1230"]]))).toBeUndefined();
  });

  it("mod11 の検査桁が合わなければ self-check で止める", () => {
    const f = fld({ selfCheck: "mod11" });
    expect(findMandatoryViolation([f], new Map([[1, "1235"]]))?.reason).toBe("self-check");
    expect(findMandatoryViolation([f], new Map([[1, "1236"]]))).toBeUndefined();
  });

  it("未編集なら snapshot の値で検算する", () => {
    const f = fld({ selfCheck: "mod10", value: "1234" });
    expect(findMandatoryViolation([f], noEdits)?.reason).toBe("self-check");
  });

  it("空欄は検算しない（空を弾くのは MANDATORY_ENTER の役目）", () => {
    expect(findMandatoryViolation([fld({ selfCheck: "mod10" })], noEdits)).toBeUndefined();
    const both = fld({ selfCheck: "mod10", mandatoryEnter: true });
    expect(findMandatoryViolation([both], noEdits)?.reason).toBe("mandatory-enter");
  });

  it("保護欄は検算しない", () => {
    const f = fld({ selfCheck: "mod10", value: "1234", protected: true });
    expect(findMandatoryViolation([f], noEdits)).toBeUndefined();
  });

  it("画面順で最初の違反を返す（自己点検と桁埋めが混ざっても）", () => {
    const a = fld({ index: 1, selfCheck: "mod11" });
    const b = fld({ index: 2, row: 6, adjust: "mandatory-fill" });
    expect(findMandatoryViolation([a, b], new Map([[1, "1235"], [2, "12"]]))?.field.index).toBe(1);
    expect(findMandatoryViolation([a, b], new Map([[1, "1236"], [2, "12"]]))?.reason).toBe("mandatory-fill");
  });

  it("止めたときの操作員メッセージがある", () => {
    expect(MSG_SELF_CHECK).toBeTruthy();
  });
});

/**
 * **J 型（FCW 0x8200）は `only`。** DBCS 種別を ACS に合わせて 4 値にしたとき、以前 "pure" と
 * 呼んでいた J 型が "only" になった。打鍵時の全角専用検査が外れないことを固定する。
 */
describe("全角専用欄の打鍵検査（only / pure）", () => {
  it.each(["only", "pure"] as const)("%s は半角を弾き、全角を通す", (dbcsType) => {
    const f = fld({ dbcsType });
    expect(rejectReason(f, "A")).toBe("dbcs-required");
    expect(rejectReason(f, "1")).toBe("dbcs-required");
    expect(rejectReason(f, "日")).toBeUndefined();
    expect(MSG_BY_REASON["dbcs-required"]).toBeTruthy();
  });

  it.each(["open", "either"] as const)("%s は半角も全角も通す", (dbcsType) => {
    const f = fld({ dbcsType });
    expect(rejectReason(f, "A")).toBeUndefined();
    expect(rejectReason(f, "日")).toBeUndefined();
  });
});
