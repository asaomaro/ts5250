import { describe, it, expect } from "vitest";
import { parseCsv } from "../src/csv-parse.js";

/**
 * CSV 解析。**web-ui と MCP の両方が使う唯一のパーサー**なので、
 * 行番号の数え方（ヘッダーを除く 1 始まり）を含めてここで固める。
 */
describe("parseCsv", () => {
  it("ヘッダーとデータ行を分ける", () => {
    expect(parseCsv("a,b\n1,2\n3,4")).toEqual({
      header: ["a", "b"],
      rows: [
        ["1", "2"],
        ["3", "4"]
      ]
    });
  });

  it("末尾の改行は行を増やさない", () => {
    expect(parseCsv("a\n1\n").rows).toEqual([["1"]]);
  });

  it("CRLF / LF / CR のいずれでも同じに読む", () => {
    const want = { header: ["a", "b"], rows: [["1", "2"]] };
    expect(parseCsv("a,b\r\n1,2")).toEqual(want);
    expect(parseCsv("a,b\n1,2")).toEqual(want);
    expect(parseCsv("a,b\r1,2")).toEqual(want);
  });

  it("BOM を取り除く（Excel の書き出し）", () => {
    expect(parseCsv("﻿a,b\n1,2").header).toEqual(["a", "b"]);
  });

  it("引用符の中のカンマは区切りにしない", () => {
    expect(parseCsv('a,b\n"x,y",z').rows).toEqual([["x,y", "z"]]);
  });

  it("引用符の中の改行は行を分けない", () => {
    expect(parseCsv('a,b\n"1\n2",3').rows).toEqual([["1\n2", "3"]]);
  });

  it('引用符の中の "" は " 1 つ', () => {
    expect(parseCsv('a\n"say ""hi"""').rows).toEqual([['say "hi"']]);
  });

  it("空行は読み飛ばす", () => {
    expect(parseCsv("a\n1\n\n2\n").rows).toEqual([["1"], ["2"]]);
  });

  it('引用符付きの空文字は「空の値」として残す', () => {
    expect(parseCsv('a,b\n"",x').rows).toEqual([["", "x"]]);
    // **1 列だけの `""` も残す**——空行の読み飛ばしと区別できていないと、
    // 行が消えて以降の行番号がずれる（レビュー指摘）
    expect(parseCsv('a\n""\nx').rows).toEqual([[""], ["x"]]);
  });

  it("ヘッダーだけなら行は空", () => {
    expect(parseCsv("a,b\n")).toEqual({ header: ["a", "b"], rows: [] });
  });

  it("列数が揃っていなくても読む（突き合わせは prepareUpload の仕事）", () => {
    expect(parseCsv("a,b,c\n1,2").rows).toEqual([["1", "2"]]);
  });

  it("日本語をそのまま通す（文字コード変換はしない）", () => {
    expect(parseCsv("名前\n日本語").rows).toEqual([["日本語"]]);
  });

  it("**閉じていない引用符は黙って直さず拒否する**", () => {
    expect(() => parseCsv('a\n"x')).toThrow(/引用符/);
  });

  it("**値の途中の引用符は解釈を決めずに拒否する**", () => {
    expect(() => parseCsv('a\nab"cd')).toThrow(/引用符/);
    // 閉じ引用符の後ろに続く文字も同じ。黙って `abcd` にしない（レビュー指摘）
    expect(() => parseCsv('a\n"ab"cd')).toThrow(/閉じ引用符/);
  });

  it("**エラーの行番号は物理行**（空行の読み飛ばしでずれない）", () => {
    // 空行を挟んでも、報告される行番号は実ファイルの行と一致する
    expect(() => parseCsv('a\n1\n\nb"c')).toThrow(/4 行目/);
  });

  it("空の入力は拒否する", () => {
    expect(() => parseCsv("")).toThrow(/空/);
  });
});
