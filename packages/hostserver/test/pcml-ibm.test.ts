import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { parsePcml } from "../src/command/pcml-parse.js";
import { buildPcmlCall } from "../src/command/pcml-layout.js";

/**
 * **IBM が配っている記述をそのまま通す。**
 *
 * `jtopen` の `pcml/` にある原本を**手を入れずに**置いてある。整えると
 * 「IBM が配る形」を通したことにならない——予約域も `outputsize` も、
 * こちらの都合で書き換えられるものではない。
 */
const ibm = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./fixtures/pcml/${name}.pcml`, import.meta.url)), "latin1");

const O = { ccsid: 37 };
/** V7R5M0。`(V << 16) + (R << 8) + M`——signon の `rawVersion` と同じ符号化 */
const V7R5 = (7 << 16) + (5 << 8);

describe("QSYRUSRI（予約域を含む取得系 API）", () => {
  const doc = parsePcml(ibm("qsyrusri"));

  it("手を入れずに解析できる", () => {
    expect([...doc.programs.keys()]).toEqual(["qsyrusri"]);
    expect(doc.programs.get("qsyrusri")?.path).toBe("/QSYS.lib/QSYRUSRI.pgm");
  });

  it("**名前なしの予約域は名前を持たない**（触れない）", () => {
    const rec = doc.programs.get("qsyrusri")!.fields[0]!;
    const named = rec.fields!.filter((f) => f.name !== "");
    expect(rec.fields).toHaveLength(16);
    expect(named).toHaveLength(14); // 予約が 2 つ
    expect(rec.fields!.map((f) => f.path).filter((p) => p === "")).toHaveLength(2);
  });

  it("**予約域もバイトは占める**（落とすと以降が全部ずれる）", () => {
    const call = buildPcmlCall(doc, "qsyrusri", { "qsyrusri.receiverLength": "83" }, O);
    const receiver = call.args[0]!;
    // 4+4+10+7+6+**1**+4+10+8+1+**1**+4+8+4+1+10 = 83
    expect("length" in receiver ? receiver.length : 0).toBe(83);
    // 予約域は名前で触れない
    expect(call.slots.some((s) => s.path === "")).toBe(false);
    // 予約の 1 バイトを飛ばした先が正しい位置にある
    const bad = call.slots.find((s) => s.path === "qsyrusri.receiver.badSignonAttempts")!;
    expect(bad.offset).toBe(4 + 4 + 10 + 7 + 6 + 1);
  });

  it("小文字の path からもライブラリーを取れる", () => {
    const call = buildPcmlCall(doc, "qsyrusri", { "qsyrusri.receiverLength": "83" }, O);
    expect(call).toMatchObject({ library: "QSYS", program: "QSYRUSRI" });
  });

  it("`init` があるので入力は長さだけ入れれば呼べる", () => {
    const call = buildPcmlCall(doc, "qsyrusri", { "qsyrusri.receiverLength": "83" }, O);
    expect(call.args.map((a) => ("dir" in a ? a.dir : undefined))).toEqual(["out", "in", "in", "in", "in"]);
  });
});

describe("QCDRCMDD（`outputsize` が入力項目を指す）", () => {
  const doc = parsePcml(ibm("qcdrcmdd"));

  it("`outputsize=\"length\"` が完全名に解ける", () => {
    expect(doc.programs.get("qcdrcmdd")!.fields[3]!.outputsize).toBe("qcdrcmdd.length");
  });

  it("**受け取る長さは入力の値で決まる**（送る量より大きい）", () => {
    const call = buildPcmlCall(doc, "qcdrcmdd", { "qcdrcmdd.name": "CRTLIB    *LIBL     " }, O);
    const receiver = call.args[3]!;
    // 記述が要るのは 8 バイト（bytesReturned + bytesAvailable）だけ。
    // 受け取るのは init="49152"
    expect("length" in receiver ? receiver.length : 0).toBe(8);
    expect("outLength" in receiver ? receiver.outLength : 0).toBe(49_152);
  });

  it("**受け取る長さが足りなければ断る**（返るバイトが黙って切れる）", () => {
    expect(() =>
      buildPcmlCall(doc, "qcdrcmdd", { "qcdrcmdd.name": "X", "qcdrcmdd.length": "4" }, O)
    ).toThrow(/受け取る長さ 4 は、記述が要る 8 より小さい/u);
  });
});

describe("RUserList（`minvrm` が引数の本数を変える）", () => {
  it("**版が分からなければ断る**（本数がずれる）", () => {
    expect(() => parsePcml(ibm("RUserList"))).toThrow(/ホストの版が分かりません/u);
  });

  it("版に届いていれば引数に入る", () => {
    const doc = parsePcml(ibm("RUserList"), { vrm: V7R5 });
    const names = doc.programs.get("qgyolaus")!.fields.map((f) => f.name);
    expect(names).toContain("profileName"); // minvrm="V5R1M0"
  });

  it("**版に届かなければ引数から外れる**", () => {
    const doc = parsePcml(ibm("RUserList"), { vrm: (4 << 16) + (5 << 8) }); // V4R5M0
    const names = doc.programs.get("qgyolaus")!.fields.map((f) => f.name);
    expect(names).not.toContain("profileName");
  });
});

describe("RUser（飛び先・出力で決まる件数と長さと CCSID）", () => {
  const doc = parsePcml(ibm("RUser"), { vrm: V7R5 });

  it("解析できる", () => {
    expect([...doc.programs.keys()]).toEqual([
      "qsyrusri_usri0100",
      "qsyrusri_usri0200",
      "qsyrusri_usri0300",
      "qokschd"
    ]);
  });

  it("**しおり（長さ 0 の名前なし項目）が飛び先を持つ**", () => {
    const rec = doc.programs.get("qsyrusri_usri0300")!.fields[0]!;
    const marks = rec.fields!.filter((f) => f.offset !== undefined);
    expect(marks).toHaveLength(3);
    expect(marks[0]!.offset).toBe("qsyrusri_usri0300.receiverVariable.offsetToArrayOfSupplementalGroups");
    expect(marks[0]!.offsetfrom).toBe(0);
    expect(marks[0]!.length).toBe(0);
  });

  it("**出力で決まる件数・長さ・CCSID が完全名に解ける**", () => {
    const rec = doc.programs.get("qsyrusri_usri0300")!.fields[0]!;
    const groups = rec.fields!.find((f) => f.name === "supplementalGroups")!;
    expect(groups.count).toBe("qsyrusri_usri0300.receiverVariable.numberOfSupplementalGroups");

    const locale = rec.fields!.find((f) => f.name === "localePathName")!;
    expect(locale.length).toBe("qsyrusri_usri0300.receiverVariable.lengthOfLocalePathName");

    const home = rec.fields!.find((f) => f.name === "homeDirectory")!;
    const value = home.fields!.find((f) => f.name === "homeDirectoryNameValue")!;
    expect(value.length).toBe(
      "qsyrusri_usri0300.receiverVariable.homeDirectory.numberOfBytesInTheHomeDirectoryName"
    );
    expect(value.ccsid).toBe(
      "qsyrusri_usri0300.receiverVariable.homeDirectory.ccsidOfTheReturnedHomeDirectoryName"
    );
  });
});

describe("そのほかの原本も解析できる", () => {
  it("QSZRTVPR / QUSLFLD", () => {
    expect([...parsePcml(ibm("qszrtvpr")).programs.keys()]).toEqual(["qszrtvpr"]);
    expect([...parsePcml(ibm("quslfld")).programs.keys()]).toEqual(["quslfld"]);
  });
});
