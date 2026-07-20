import { describe, it, expect } from "vitest";
import { prepareUpload, type UploadRejection } from "../src/hostserver/ddm/upload-prepare.js";
import type { ColumnLayoutInput } from "../src/hostserver/ddm/record-layout.js";

/**
 * 取り込みの事前検査。
 *
 * **本作業のロジックの大半がここにある**（design DD1）。DDM は巻き戻せないので、
 * 「書く前に全部わかる」ことが仕様上の要求そのもの。純関数なので実機なしで固められる。
 */

/** PUB400 の MYLIB.TESTPF 相当（CHAR(5)×4・CCSID 273） */
const TESTPF: ColumnLayoutInput[] = [
  { name: "TEST1", dataType: "CHAR", length: 5, scale: 0, nullable: false, ccsid: 273 },
  { name: "TEST2", dataType: "CHAR", length: 5, scale: 0, nullable: false, ccsid: 273 }
];

/** PUB400 の MYLIB.CSVUPJP 相当（273 と 5035 が混在） */
const CSVUPJP: ColumnLayoutInput[] = [
  { name: "ID", dataType: "SMALLINT", length: 5, scale: 0, nullable: false },
  { name: "C_SBCS", dataType: "CHAR", length: 20, scale: 0, nullable: true, ccsid: 273 },
  { name: "C_JP", dataType: "CHAR", length: 20, scale: 0, nullable: true, ccsid: 5035 }
];

const kinds = (rs: UploadRejection[]): string[] => rs.map((r) => r.kind);

describe("正常系", () => {
  it("列の宣言順にレコードを組み立てる（CSV の列順は表と無関係でよい）", () => {
    const res = prepareUpload({
      columns: TESTPF,
      header: ["TEST2", "TEST1"], // ← 表とは逆順
      rows: [["bb", "aa"]]
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.records).toHaveLength(1);
    // TEST1 が先頭（宣言順）。'a' は EBCDIC 0x81
    expect(res.records[0]!.data[0]).toBe(0x81);
    // TEST2 は offset 5 から。'b' は 0x82
    expect(res.records[0]!.data[5]).toBe(0x82);
  });

  it("列名の突き合わせは大小文字と前後空白を無視する", () => {
    const res = prepareUpload({ columns: TESTPF, header: [" test1 ", "Test2"], rows: [["a", "b"]] });
    expect(res.ok).toBe(true);
  });

  it("CSV に無い列は NULL 扱いにする（NULL 可なら通る）", () => {
    const res = prepareUpload({ columns: CSVUPJP, header: ["ID"], rows: [["1"]] });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.records[0]!.nulls).toEqual([false, true, true]);
  });

  it("emptyAsNull で空文字を NULL にできる（既定は空文字のまま）", () => {
    const asEmpty = prepareUpload({ columns: CSVUPJP, header: ["ID", "C_SBCS"], rows: [["1", ""]] });
    const asNull = prepareUpload({
      columns: CSVUPJP,
      header: ["ID", "C_SBCS"],
      rows: [["1", ""]],
      emptyAsNull: true
    });
    expect(asEmpty.ok && asEmpty.records[0]!.nulls[1]).toBe(false);
    expect(asNull.ok && asNull.records[0]!.nulls[1]).toBe(true);
  });

  it("**日本語は日本語 CCSID の列に書ける**", () => {
    const res = prepareUpload({ columns: CSVUPJP, header: ["ID", "C_JP"], rows: [["1", "日本語"]] });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // C_JP は offset 22（SMALLINT 2 + C_SBCS 20 の後ろ）。混在 CCSID なので SO で始まる
    expect(res.layout.fields[2]!.offset).toBe(22);
    expect(res.records[0]!.data[22]).toBe(0x0e);
  });
});

describe("構造の拒否（行を見る前に止める）", () => {
  it("対応外の型は列名と型名を添えて拒否する", () => {
    const res = prepareUpload({
      columns: [{ name: "D", dataType: "DATE", length: 4, scale: 0, nullable: true }],
      header: ["D"],
      rows: [["2026-07-20"]]
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.rejections).toEqual([{ kind: "type-unsupported", column: "D", dataType: "DATE" }]);
  });

  it("**CCSID 65535（変換なし）は代替せずに拒否する**", () => {
    const res = prepareUpload({
      columns: [{ name: "B", dataType: "CHAR", length: 4, scale: 0, nullable: true, ccsid: 65535 }],
      header: ["B"],
      rows: [["x"]]
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.rejections).toEqual([{ kind: "ccsid-unsupported", column: "B", ccsid: 65535 }]);
  });

  it("コーデックを持たない CCSID も拒否する", () => {
    const res = prepareUpload({
      columns: [{ name: "C", dataType: "CHAR", length: 4, scale: 0, nullable: true, ccsid: 1141 }],
      header: ["C"],
      rows: [["x"]]
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(kinds(res.rejections)).toEqual(["ccsid-unsupported"]);
  });

  it("表に無い列は列名を返す", () => {
    const res = prepareUpload({ columns: TESTPF, header: ["TEST1", "NOPE"], rows: [["a", "b"]] });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.rejections).toContainEqual({ kind: "column-unknown", columns: ["NOPE"] });
  });

  it("NULL を受け付けない列が CSV に無ければ拒否する", () => {
    const res = prepareUpload({ columns: TESTPF, header: ["TEST1"], rows: [["a"]] });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.rejections).toContainEqual({ kind: "column-missing", columns: ["TEST2"] });
  });

  it("構造が崩れているときは行の検査をしない（意味のある指摘にならないため）", () => {
    const res = prepareUpload({
      columns: TESTPF,
      header: ["TEST1", "TEST2", "NOPE"],
      rows: [["aaaaaaaaaa", "b", "c"]] // 1 列目は長すぎるが、そこは報告しない
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(kinds(res.rejections)).toEqual(["column-unknown"]);
  });
});

describe("値の拒否", () => {
  it("**表現できない文字は置換せず、どの文字かを返す**", () => {
    const res = prepareUpload({ columns: TESTPF, header: ["TEST1", "TEST2"], rows: [["日本", "b"]] });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.rejections).toEqual([
      { kind: "value-unencodable", row: 1, column: "TEST1", chars: ["日", "本"], ccsid: 273 }
    ]);
  });

  it("長すぎる値は切り詰めずバイト数を添えて拒否する", () => {
    const res = prepareUpload({ columns: TESTPF, header: ["TEST1", "TEST2"], rows: [["abcdef", "b"]] });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.rejections).toEqual([
      { kind: "value-too-long", row: 1, column: "TEST1", bytes: 6, max: 5 }
    ]);
  });

  it("数値でない値は行番号と列名を添えて拒否する", () => {
    const res = prepareUpload({ columns: CSVUPJP, header: ["ID"], rows: [["1"], ["未定"]] });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.rejections).toEqual([
      { kind: "value-not-numeric", row: 2, column: "ID", value: "未定" }
    ]);
  });

  it("NULL を受け付けない列に NULL が来たら拒否する", () => {
    const res = prepareUpload({
      columns: TESTPF,
      header: ["TEST1", "TEST2"],
      rows: [["a", ""]],
      emptyAsNull: true
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.rejections).toEqual([{ kind: "value-null", row: 1, column: "TEST2" }]);
  });

  it("**行番号は 1 始まり**（ヘッダーを含めない）", () => {
    const res = prepareUpload({
      columns: TESTPF,
      header: ["TEST1", "TEST2"],
      rows: [["a", "b"], ["c", "d"], ["abcdef", "e"]]
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect((res.rejections[0] as { row: number }).row).toBe(3);
  });

  it("**複数の拒否をまとめて返す**（最初の 1 件で止めない）", () => {
    const res = prepareUpload({
      columns: TESTPF,
      header: ["TEST1", "TEST2"],
      rows: [["abcdef", "b"], ["日", "c"], ["a", "abcdef"]]
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.rejections).toHaveLength(3);
    expect(kinds(res.rejections)).toEqual([
      "value-too-long",
      "value-unencodable",
      "value-too-long"
    ]);
  });

  it("1 行に複数の問題があれば両方返す", () => {
    const res = prepareUpload({
      columns: TESTPF,
      header: ["TEST1", "TEST2"],
      rows: [["abcdef", "日"]]
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.rejections).toHaveLength(2);
  });

  it("拒否は 100 件で打ち切り、truncated を立てる", () => {
    const rows = Array.from({ length: 150 }, () => ["abcdef", "b"]);
    const res = prepareUpload({ columns: TESTPF, header: ["TEST1", "TEST2"], rows });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.rejections).toHaveLength(100);
    expect(res.truncated).toBe(true);
  });

  it("**1 件でも拒否があれば 1 行もレコードを返さない**（部分的に書かせない）", () => {
    const res = prepareUpload({
      columns: TESTPF,
      header: ["TEST1", "TEST2"],
      rows: [["a", "b"], ["abcdef", "c"]]
    });
    expect(res.ok).toBe(false); // records そのものが返らない型になっている
  });
});
