import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCommandTemplate } from "../src/command/command-template.js";
import { buildCommand, formatValue } from "../src/command/command-build.js";

/**
 * **CL コマンドのテンプレート**（`QCDRCMDD` が返す定義 XML）の解析と組み立て。
 *
 * fixture は**実機から採った本物**（社内 IBM i の `CRTLIB` と `CPYF`）。
 * 手で書いた XML では、実際に来る属性の並びや `Qual` の入れ子を取りこぼす。
 */

const here = dirname(fileURLToPath(import.meta.url));
const xml = (name: string): string => readFileSync(join(here, "fixtures", name), "utf8");
const crtlib = parseCommandTemplate(xml("cmdd-crtlib.xml"));
const cpyf = parseCommandTemplate(xml("cmdd-cpyf.xml"));

describe("テンプレートの解析", () => {
  it("**コマンドの素性が取れる**", () => {
    expect(crtlib.name).toBe("CRTLIB");
    expect(crtlib.library).toBe("QSYS");
    expect(crtlib.prompt).toBe("Create Library");
    expect(crtlib.maxPositional).toBe(2);
  });

  it("**パラメータの必須・既定・桁数が取れる**", () => {
    const lib = crtlib.parameters.find((p) => p.keyword === "LIB")!;
    expect(lib.required, "LIB は必須（Min=1）").toBe(true);
    expect(lib.type).toBe("NAME");
    expect(lib.length).toBe(10);
    expect(lib.position).toBe(1);

    const type = crtlib.parameters.find((p) => p.keyword === "TYPE")!;
    expect(type.required).toBe(false);
    expect(type.default).toBe("*PROD");
    expect(type.restricted, "Rstd=YES").toBe(true);
    expect(type.specialValues).toEqual(["*PROD", "*TEST"]);
  });

  it("**修飾パラメータは段ごとに取れる**（`CPYF` の `FROMFILE`）", () => {
    const from = cpyf.parameters.find((p) => p.keyword === "FROMFILE")!;
    expect(from.type).toBe("QUAL");
    expect(from.required).toBe(true);
    expect(from.qualifiers).toHaveLength(2); // オブジェクト名・ライブラリー
    expect(from.qualifiers![1]!.default).toBe("*LIBL");
    expect(from.qualifiers![1]!.specialValues).toEqual(["*LIBL", "*CURLIB"]);
  });

  it("**生の XML を捨てない**（解いていない属性を読めるように）", () => {
    expect(crtlib.xml).toContain("HlpPnlGrp=");
    expect(crtlib.xml.length).toBeGreaterThan(3000);
  });

  it("**繰り返せるパラメータが分かる**", () => {
    const many = cpyf.parameters.filter((p) => p.maxValues > 1);
    expect(many.length, "CPYF には繰り返し可能な欄がある").toBeGreaterThan(0);
  });
});

describe("値の書き方", () => {
  it("**特殊値と名前はそのまま**", () => {
    expect(formatValue("*PROD")).toBe("*PROD");
    expect(formatValue("ASAOLIB")).toBe("ASAOLIB");
    expect(formatValue("QSYS/QCMD")).toBe("QSYS/QCMD");
    expect(formatValue(42)).toBe("42");
  });

  it("**空白・記号は囲む**", () => {
    expect(formatValue("hello world")).toBe("'hello world'");
    expect(formatValue("a,b")).toBe("'a,b'");
  });

  it("**小文字は囲む**——囲まないと CL が大文字に畳んでしまう", () => {
    expect(formatValue("abc")).toBe("'abc'");
  });

  it("**引用符は二重にする**", () => {
    expect(formatValue("It's a test")).toBe("'It''s a test'");
    expect(formatValue("''")).toBe("''''''");
  });

  it("**空文字は空の文字定数**", () => {
    expect(formatValue("")).toBe("''");
  });
});

describe("組み立て", () => {
  it("**キーワードつきで組む**", () => {
    expect(buildCommand(crtlib, { LIB: "ASAOLIB" })).toBe("CRTLIB LIB(ASAOLIB)");
  });

  it("**引用が要る値を機械が囲む**", () => {
    expect(buildCommand(crtlib, { LIB: "ASAOLIB", TEXT: "It's a test" })).toBe(
      "CRTLIB LIB(ASAOLIB) TEXT('It''s a test')"
    );
  });

  it("**並びはテンプレート順**（同じ入力からは同じ文字列）", () => {
    const a = buildCommand(crtlib, { TEXT: "x y", TYPE: "*TEST", LIB: "L" });
    const b = buildCommand(crtlib, { LIB: "L", TYPE: "*TEST", TEXT: "x y" });
    expect(a).toBe(b);
    expect(a.indexOf("LIB(")).toBeLessThan(a.indexOf("TYPE("));
  });

  it("**知らないキーワードは打つ前に弾く**", () => {
    expect(() => buildCommand(crtlib, { LIBB: "X" })).toThrow(/no parameter LIBB/);
  });

  it("**必須の抜けは打つ前に弾く**", () => {
    expect(() => buildCommand(crtlib, { TEXT: "x" })).toThrow(/requires LIB/);
  });

  it("**許されない値は打つ前に弾く**（`Rstd=YES`）", () => {
    expect(() => buildCommand(crtlib, { LIB: "L", TYPE: "*PRDO" })).toThrow(/accepts only/);
    expect(buildCommand(crtlib, { LIB: "L", TYPE: "*TEST" })).toContain("TYPE(*TEST)");
  });

  it("**桁溢れは打つ前に弾く**", () => {
    expect(() => buildCommand(crtlib, { LIB: "TOOLONGLIBNAME" })).toThrow(/up to 10 characters/);
  });

  it("**配列は繰り返しになる**（`KWD(A B)`）", () => {
    // `PRINT` は繰り返せて、許される値も決まっている（実機の定義より）
    const print = cpyf.parameters.find((p) => p.keyword === "PRINT")!;
    expect(print.maxValues).toBeGreaterThan(1);
    const two = print.specialValues.slice(0, 2);
    const out = buildCommand(cpyf, { FROMFILE: "QGPL/A", TOFILE: "QGPL/B", PRINT: two });
    expect(out).toContain(`PRINT(${two.join(" ")})`);
  });

  it("**繰り返しの個数が多すぎれば弾く**", () => {
    const print = cpyf.parameters.find((p) => p.keyword === "PRINT")!;
    const many = Array.from({ length: print.maxValues + 1 }, () => print.specialValues[0]!);
    expect(() => buildCommand(cpyf, { FROMFILE: "A", TOFILE: "B", PRINT: many })).toThrow(
      /up to \d+ value/
    );
  });

  it("**逃げ道**——テンプレートに無いキーワードも通せる（検証はされない）", () => {
    const out = buildCommand(crtlib, { LIB: "L", NEWKWD: "V" }, { allowUnknown: true });
    expect(out).toBe("CRTLIB LIB(L) NEWKWD(V)");
  });
});
