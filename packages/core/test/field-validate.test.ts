import { describe, it, expect } from "vitest";
import { validateFieldContent } from "../src/screen/field-validate.js";
import { codecForCcsid } from "../src/codec/codec.js";
import { FFW } from "../src/protocol/constants.js";
import type { InternalField } from "../src/screen/buffer.js";

const sbcs = codecForCcsid(37);
const dbcs = codecForCcsid(1399);

function field(ffw: number, dbcsType?: "pure" | "open" | "either"): InternalField {
  return { startAddr: 0, length: 20, ffw, attrByte: 0x24, mdt: false, ...(dbcsType ? { dbcsType } : {}) };
}

describe("validateFieldContent — 数値型", () => {
  const numField = field(FFW.ID_VALUE | FFW.SHIFT_NUMERIC_ONLY);
  it("数字・符号・小数点は許可", () => {
    expect(() => validateFieldContent("123.45", numField, sbcs)).not.toThrow();
    expect(() => validateFieldContent("-12", numField, sbcs)).not.toThrow();
  });
  it("英字は FIELD_TYPE で拒否", () => {
    expect(() => validateFieldContent("12A", numField, sbcs)).toThrow(
      expect.objectContaining({ code: "FIELD_TYPE" })
    );
  });
  it("digits-only は小数点も拒否", () => {
    const digits = field(FFW.ID_VALUE | FFW.SHIFT_DIGITS_ONLY);
    expect(() => validateFieldContent("12.3", digits, sbcs)).toThrow(
      expect.objectContaining({ code: "FIELD_TYPE" })
    );
  });
});

describe("validateFieldContent — コードページ許容文字", () => {
  it("CCSID 37 の英数字は許可", () => {
    expect(() => validateFieldContent("HELLO123", field(FFW.ID_VALUE), sbcs)).not.toThrow();
  });
  it("CCSID 37 に日本語は入力不可（FIELD_TYPE）", () => {
    expect(() => validateFieldContent("あ", field(FFW.ID_VALUE), sbcs)).toThrow(
      expect.objectContaining({ code: "FIELD_TYPE" })
    );
  });
  it("CCSID 1399 では日本語も英数字も許可", () => {
    expect(() => validateFieldContent("日本ABC", field(FFW.ID_VALUE), dbcs)).not.toThrow();
  });
});

describe("validateFieldContent — DBCS 種別", () => {
  it("pure（J 型）は DBCS のみ許可、SBCS を拒否", () => {
    const pure = field(FFW.ID_VALUE, "pure");
    expect(() => validateFieldContent("日本語", pure, dbcs)).not.toThrow();
    expect(() => validateFieldContent("日A", pure, dbcs)).toThrow(
      expect.objectContaining({ code: "FIELD_TYPE" })
    );
  });
  it("open（O 型）は SBCS/DBCS 混在を許可", () => {
    const open = field(FFW.ID_VALUE, "open");
    expect(() => validateFieldContent("A日B", open, dbcs)).not.toThrow();
  });
});
