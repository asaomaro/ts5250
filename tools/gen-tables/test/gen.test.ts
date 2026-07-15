import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseUcm } from "../src/ucm.js";
import { emitSbcsTable } from "../src/emit-sbcs.js";

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
