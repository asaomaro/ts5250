import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseUcm } from "../src/ucm.js";
import { emitSbcsTable } from "../src/emit-sbcs.js";
import { emitStatefulTable } from "../src/emit-stateful.js";

const here = dirname(fileURLToPath(import.meta.url));

const SAMPLE = `
<code_set_name>  "test-cs"
<mb_cur_max>     1
<mb_cur_min>     1
<uconv_class>    "SBCS"
<subchar>        \\x3F
CHARMAP
<U0041> \\xC1 |0
<U0020> \\x40 |0
<U00A6> \\x6A |1
<U001A> \\x3F |2
<U009F> \\xFF |3
END CHARMAP
`;

describe("parseUcm", () => {
  it("ヘッダと CHARMAP を解析する", () => {
    const ucm = parseUcm(SAMPLE);
    expect(ucm.header.codeSetName).toBe("test-cs");
    expect(ucm.header.uconvClass).toBe("SBCS");
    expect(ucm.header.subchar).toEqual([0x3f]);
    expect(ucm.entries).toHaveLength(5);
    expect(ucm.entries[0]).toEqual({ unicode: 0x41, bytes: [0xc1], flag: 0 });
  });

  it("ibm-37 の実ファイルを解析できる", () => {
    const text = readFileSync(join(here, "..", "ucm", "ibm-37_P100-1999.ucm"), "utf8");
    const ucm = parseUcm(text);
    expect(ucm.header.codeSetName).toBe("ibm-37_P100-1999");
    expect(ucm.header.uconvClass).toBe("SBCS");
    // 'A' U+0041 <-> 0xC1 の roundtrip が存在する
    const a = ucm.entries.find((e) => e.unicode === 0x41);
    expect(a?.bytes).toEqual([0xc1]);
    expect(a?.flag).toBe(0);
  });
});

describe("emitSbcsTable", () => {
  it("方向規則どおりに双方向テーブルを出力する", () => {
    const code = emitSbcsTable(parseUcm(SAMPLE), {
      ccsid: 999,
      exportName: "test999",
      sourceFile: "sample.ucm"
    });
    // roundtrip |0: 両方向
    expect(code).toContain("0xc1, 0x41"); // E2U
    expect(code).toContain("0x41, 0xc1"); // U2E
    // |1 fallback: U2E のみ
    expect(code).toContain("0xa6, 0x6a");
    expect(code).not.toContain("0x6a, 0xa6");
    // |3 reverse fallback: E2U のみ
    expect(code).toContain("0xff, 0x9f");
    expect(code).not.toContain("0x9f, 0xff");
    // |2 subchar1: 双方向とも捨てる（U+001A のマッピングを出さない）
    expect(code).not.toContain("0x1a,");
    expect(code).toContain("sub: 0x3f");
  });

  it("SBCS 以外は拒否する", () => {
    const dbcs = SAMPLE.replace('"SBCS"', '"EBCDIC_STATEFUL"');
    expect(() =>
      emitSbcsTable(parseUcm(dbcs), { ccsid: 930, exportName: "x", sourceFile: "x.ucm" })
    ).toThrow(/subtask 04/);
  });
});

const STATEFUL_SAMPLE = `
<code_set_name>  "test-mixed"
<mb_cur_max>     2
<mb_cur_min>     1
<uconv_class>    "EBCDIC_STATEFUL"
<subchar>        \\x3F
CHARMAP
<U0041> \\xC1 |0
<U0020> \\x40 |0
<U30A2> \\x42\\xA1 |0
<U30A4> \\x42\\xA2 |1
<U30A6> \\x42\\xA3 |3
END CHARMAP
`;

describe("emitStatefulTable（SBCS 部 / DBCS 部の分割）", () => {
  const mods = emitStatefulTable(parseUcm(STATEFUL_SAMPLE), {
    ccsid: 999,
    exportName: "test999",
    sourceFile: "sample.ucm"
  });

  it("SBCS 部のモジュールに DBCS のデータが混ざらない", () => {
    // 1 バイトエントリだけが入る（0xC1=193 → 0x41=65 / 0x40=64 → 0x20=32）
    expect(mods.sbcs).toContain("193,65");
    expect(mods.sbcs).toContain("export const test999Sbcs: SbcsTable");
    // DBCS の packed 値（0x42A1 = 17057）は現れない
    expect(mods.sbcs).not.toContain("17057");
    expect(mods.sbcs).not.toContain("DbcsPart");
  });

  it("DBCS 部のモジュールに SBCS のデータが混ざらない", () => {
    // 2 バイトエントリだけが入る（0x42A1 = 17057 → U+30A2 = 12450）
    expect(mods.dbcs).toContain("17057,12450");
    expect(mods.dbcs).toContain("export const test999Dbcs: DbcsPart");
    expect(mods.dbcs).not.toContain("SbcsTable");
    expect(mods.dbcs).toContain("sub: 0xfefe");
  });

  it("方向規則は分割前と同じ（flag 1 は U2E のみ・flag 3 は E2U のみ・flag 2 は捨てる）", () => {
    // |1 fallback（U+30A4 = 12452 → 0x42A2 = 17058）: U2E のみ
    expect(mods.dbcs).toContain("12452,17058");
    expect(mods.dbcs).not.toContain("17058,12452");
    // |3 reverse fallback（0x42A3 = 17059 → U+30A6 = 12454）: E2U のみ
    expect(mods.dbcs).toContain("17059,12454");
    expect(mods.dbcs).not.toContain("12454,17059");
  });

  it("合成モジュールは表を持たず、両者を組み立てるだけ", () => {
    expect(mods.index).toContain('from "./test999-sbcs.js"');
    expect(mods.index).toContain('from "./test999-dbcs.js"');
    expect(mods.index).toContain("export const test999: StatefulTable");
    // 数値データは 1 つも埋め込まれない（ccsid の 999 以外に数字の羅列が無い）
    expect(mods.index).not.toContain("17057");
    expect(mods.index).not.toContain("193,65");
  });

  it("3 モジュールすべてに出典表記が付く（分割で出典を落とさない）", () => {
    for (const code of [mods.sbcs, mods.dbcs, mods.index]) {
      expect(code).toContain("AUTO-GENERATED");
      expect(code).toContain("ICU (unicode-org/icu-data)");
      expect(code).toContain("Unicode License V3");
      expect(code).toContain("npm run gen:tables");
    }
  });

  it("EBCDIC_STATEFUL 以外は拒否する", () => {
    expect(() =>
      emitStatefulTable(parseUcm(SAMPLE), { ccsid: 999, exportName: "x", sourceFile: "x.ucm" })
    ).toThrow(/EBCDIC_STATEFUL/);
  });
});
