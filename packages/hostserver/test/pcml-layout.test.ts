import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { codecForCcsid } from "@ts5250/ebcdic";
import { parsePcml } from "../src/command/pcml-parse.js";
import { buildPcmlCall, readPcmlOutputs, pcmlTarget } from "../src/command/pcml-layout.js";
import { stringToPackedDecimal, stringToZonedDecimal } from "../src/db/db-decimal.js";

/**
 * **記述 → 引数の列 → 名前つきの結果。**
 *
 * 並び方は**実機で測ってある**（`research.md` C）——構造体は連結、配列は反復。
 * ここで固定するのはその並びと、「足りない入力を黙って埋めない」という約束。
 */
const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");

const REAL = parsePcml(fixture("pcmltst.pcml"));
const VAR = parsePcml(fixture("varcount.pcml"));
const O = { ccsid: 37 };
const cp = codecForCcsid(37);

const un64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "base64"));
const bytesOf = (a: { value?: string }): Uint8Array => un64(a.value ?? "");

/** 実機と同じ値（`research-pcml-layout.mjs` に揃えてある） */
const VALUES: Record<string, string> = {
  "PCMLTST.INTXT": "HELLO",
  "PCMLTST.IONUM": "12.34",
  "PCMLTST.REC.ID": "0",
  "PCMLTST.REC.NM": "",
  "PCMLTST.REC.RATE": "0",
  "PCMLTST.ITEMS(1)": "",
  "PCMLTST.ITEMS(2)": "",
  "PCMLTST.ITEMS(3)": "",
  "PCMLTST.ITEMS(4)": "",
  "PCMLTST.CNT": "0",
  "PCMLTST.BIG": "0",
  "PCMLTST.AMT": "1.00"
};

describe("引数の組み立て", () => {
  it("**1 項目 = 1 引数**（構造体を分割しない。分けると本数が変わって MCH0802 になる）", () => {
    const call = buildPcmlCall(REAL, "PCMLTST", { ...VALUES, "PCMLTST.REC.NM": "X" }, O);
    expect(call.args).toHaveLength(7);
    expect(call.args.map((a) => ("length" in a ? a.length : 0))).toEqual([10, 5, 29, 20, 4, 8, 7]);
  });

  it("向きは中の葉から決まる", () => {
    const call = buildPcmlCall(REAL, "PCMLTST", { ...VALUES, "PCMLTST.REC.NM": "X" }, O);
    expect(call.args.map((a) => ("dir" in a ? a.dir : undefined))).toEqual([
      "in",
      "inout",
      "inout",
      "inout",
      "inout",
      "inout",
      "inout"
    ]);
  });

  it("**構造体は連結**（ID 4 + NM 20 + RATE 5 = 29）", () => {
    const call = buildPcmlCall(REAL, "PCMLTST", { ...VALUES, "PCMLTST.REC.NM": "ABC" }, O);
    const rec = bytesOf(call.args[2] as { value?: string });
    expect(rec).toHaveLength(29);
    expect([...rec.subarray(0, 4)]).toEqual([...stringToPackedDecimal("0", 7, 0)]);
    expect(cp.decode(rec.subarray(4, 24))).toBe("ABC".padEnd(20));
    expect([...rec.subarray(24)]).toEqual([...stringToPackedDecimal("0", 9, 4)]);
  });

  it("**配列は反復**（5 バイト × 4）", () => {
    const call = buildPcmlCall(
      REAL,
      "PCMLTST",
      { ...VALUES, "PCMLTST.REC.NM": "X", "PCMLTST.ITEMS(3)": "CCC" },
      O
    );
    const items = bytesOf(call.args[3] as { value?: string });
    expect(items).toHaveLength(20);
    expect(cp.decode(items.subarray(10, 15))).toBe("CCC  ");
  });

  it("**配列の名前は 1 始まり**（PCML の慣習）", () => {
    const call = buildPcmlCall(REAL, "PCMLTST", { ...VALUES, "PCMLTST.REC.NM": "X" }, O);
    const paths = call.slots.map((s) => s.path);
    expect(paths).toContain("PCMLTST.ITEMS(1)");
    expect(paths).toContain("PCMLTST.ITEMS(4)");
    expect(paths).not.toContain("PCMLTST.ITEMS(0)");
    expect(paths).toContain("PCMLTST.REC.NM");
  });

  it("ゾーン 10 進もそのまま詰まる", () => {
    const call = buildPcmlCall(REAL, "PCMLTST", { ...VALUES, "PCMLTST.REC.NM": "X" }, O);
    expect([...bytesOf(call.args[6] as { value?: string })]).toEqual([...stringToZonedDecimal("1.00", 7, 2)]);
  });
});

describe("足りない入力は黙って埋めない", () => {
  it("値も init も無ければ、**どの項目か**を言って断る", () => {
    const partial = { ...VALUES };
    delete partial["PCMLTST.IONUM"];
    expect(() => buildPcmlCall(REAL, "PCMLTST", partial, O)).toThrow(/PCMLTST\.IONUM は inputoutput/u);
  });

  it("`init` があればそれを使う", () => {
    const call = buildPcmlCall(VAR, "LISTER", { "LISTER.FLAGS": "AAAA" }, O);
    // COUNT は init="2"。件数もそれで決まる → ENTRIES は 14 バイト × 2
    expect(("length" in call.args[1]! ? call.args[1]!.length : 0)).toBe(28);
  });

  it("知らないプログラム名は、あるものを挙げて断る", () => {
    expect(() => buildPcmlCall(REAL, "NOPE", {}, O)).toThrow(/あるのは: PCMLTST/u);
  });
});

describe("可変長の配列", () => {
  it("入力の値で件数が決まる", () => {
    const call = buildPcmlCall(VAR, "LISTER", { "LISTER.COUNT": "3", "LISTER.FLAGS": "AAAA" }, O);
    expect(("length" in call.args[1]! ? call.args[1]!.length : 0)).toBe(42); // (10 + 4) × 3
    expect(call.slots.map((s) => s.path)).toContain("LISTER.ENTRIES(3).NAME");
  });

  it("**出力だけの引数は長さしか渡さない**", () => {
    const call = buildPcmlCall(VAR, "LISTER", { "LISTER.COUNT": "1", "LISTER.FLAGS": "AAAA" }, O);
    const entries = call.args[1]!;
    expect("dir" in entries ? entries.dir : undefined).toBe("out");
    expect("value" in entries ? entries.value : undefined).toBeUndefined();
  });

  it("件数が決まらなければ**呼ばない**（0 件にするとホストが領域外に書く）", () => {
    const doc = parsePcml(
      [
        '<pcml version="1.0"><program name="P">',
        '<data name="N" type="int" length="4" usage="output" />',
        '<data name="A" type="char" length="4" count="N" usage="output" />',
        "</program></pcml>"
      ].join("\n")
    );
    expect(() => buildPcmlCall(doc, "P", {}, O)).toThrow(/呼ぶ前に P\.N を入れて/u);
  });
});

describe("結果を名前で読む", () => {
  it("構造体の中も配列の中も名前で取れる", () => {
    const call = buildPcmlCall(REAL, "PCMLTST", { ...VALUES, "PCMLTST.REC.NM": "X" }, O);
    // 実機が返したのと同じ形を組む
    const rec = new Uint8Array(29);
    rec.set(stringToPackedDecimal("7", 7, 0), 0);
    rec.set(cp.encode("REC:HELLO".padEnd(20)).bytes, 4);
    rec.set(stringToPackedDecimal("1.5", 9, 4), 24);
    const items = cp.encode("AAA  BBB  CCC  DDD  ").bytes;
    const cnt = new Uint8Array([0, 0, 0, 4]);
    const big = new Uint8Array([0, 0, 0, 2, 24, 113, 26, 0]); // 9,000,000,000
    const amt = stringToZonedDecimal("2.00", 7, 2);

    const got = readPcmlOutputs(call, [
      undefined,
      stringToPackedDecimal("24.68", 9, 2),
      rec,
      items,
      cnt,
      big,
      amt
    ]);

    expect(got["PCMLTST.IONUM"]).toBe("24.68");
    expect(got["PCMLTST.REC.ID"]).toBe("7");
    expect(got["PCMLTST.REC.NM"]?.trim()).toBe("REC:HELLO");
    expect(got["PCMLTST.REC.RATE"]).toBe("1.5000");
    expect(got["PCMLTST.ITEMS(2)"]?.trim()).toBe("BBB");
    expect(got["PCMLTST.CNT"]).toBe("4");
    expect(got["PCMLTST.BIG"]).toBe("9000000000");
    expect(got["PCMLTST.AMT"]).toBe("2.00");
  });

  it("**入力専用は結果に出ない**（ホストは書いていない）", () => {
    const call = buildPcmlCall(REAL, "PCMLTST", { ...VALUES, "PCMLTST.REC.NM": "X" }, O);
    const got = readPcmlOutputs(call, [new Uint8Array(10), undefined, undefined, undefined, undefined, undefined, undefined]);
    expect(got["PCMLTST.INTXT"]).toBeUndefined();
  });

  it("**符号なし整数は precision=32 で符号なしになる**", () => {
    const call = buildPcmlCall(VAR, "LISTER", { "LISTER.COUNT": "1", "LISTER.FLAGS": "AAAA" }, O);
    const entries = new Uint8Array(14);
    entries.set(cp.encode("X".padEnd(10)).bytes, 0);
    entries.set([0xff, 0xff, 0xff, 0xff], 10);
    const got = readPcmlOutputs(call, [undefined, entries, undefined]);
    expect(got["LISTER.ENTRIES(1).SIZE"]).toBe("4294967295");
  });

  it("浮動小数を読める", () => {
    const call = buildPcmlCall(VAR, "LISTER", { "LISTER.COUNT": "1", "LISTER.FLAGS": "AAAA" }, O);
    const ratio = new Uint8Array(8);
    new DataView(ratio.buffer).setFloat64(0, 0.5, false);
    const got = readPcmlOutputs(call, [undefined, undefined, ratio]);
    expect(got["LISTER.RATIO"]).toBe("0.5");
  });
});

describe("呼び先の解決", () => {
  it("path から ライブラリとプログラムを取る", () => {
    expect(pcmlTarget({ name: "X", path: "/QSYS.LIB/TESTLIB.LIB/PCMLTST.PGM", fields: [] })).toEqual({
      program: "PCMLTST",
      library: "TESTLIB"
    });
  });

  it("**ライブラリ修飾が 1 段なら QSYS**（`/QSYS.LIB/X.PGM` は QSYS のもの）", () => {
    expect(pcmlTarget({ name: "X", path: "/QSYS.LIB/PCMLTST.PGM", fields: [] }).library).toBe("QSYS");
  });

  it("path が無ければ *LIBL から探す", () => {
    expect(pcmlTarget({ name: "PCMLTST", fields: [] })).toEqual({ program: "PCMLTST", library: "*LIBL" });
  });

  it("サービスプログラムでも取れる", () => {
    expect(pcmlTarget({ name: "X", path: "/QSYS.LIB/D.LIB/SRV.SRVPGM", fields: [] })).toEqual({
      program: "SRV",
      library: "D"
    });
  });
});

describe("失敗はどの項目かを言う", () => {
  it("**10 進の変換の失敗にも項目名が付く**（構造体の中では値だけでは探せない）", () => {
    expect(() => buildPcmlCall(REAL, "PCMLTST", { ...VALUES, "PCMLTST.IONUM": "" }, O)).toThrow(
      /PCMLTST\.IONUM: .*読めません/u
    );
  });

  it("長さ超過にも付く", () => {
    expect(() =>
      buildPcmlCall(REAL, "PCMLTST", { ...VALUES, "PCMLTST.REC.NM": "x".repeat(21) }, O)
    ).toThrow(/PCMLTST\.REC\.NM が 20 バイトに収まりません/u);
  });
});
