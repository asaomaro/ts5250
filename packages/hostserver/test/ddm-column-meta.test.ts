import { describe, it, expect } from "vitest";
import { assertIdentifier } from "../src/ddm/column-meta.js";

/**
 * 識別子の検査。**SQL への文字列連結を避けられない箇所の防壁**なので、
 * 通す条件を明示的に固定する（取り込みと取得の両方がこれを使う）。
 */
describe("assertIdentifier", () => {
  it("正規化して返す（前後空白の除去と大文字化）", () => {
    expect(assertIdentifier(" testlib ", "ライブラリ名")).toBe("MYLIB");
  });

  it("IBM i で使える記号を通す", () => {
    expect(assertIdentifier("A_B$C#D@", "ファイル名")).toBe("A_B$C#D@");
  });

  it("10 文字まで", () => {
    expect(assertIdentifier("ABCDEFGHIJ", "x")).toBe("ABCDEFGHIJ");
    expect(() => assertIdentifier("ABCDEFGHIJK", "x")).toThrow();
  });

  it.each([
    ["空", ""],
    ["引用符", `A'B`],
    ["セミコロン", "A;B"],
    ["空白入り", "A B"],
    ["SQL 断片", "X' OR '1'='1"],
    ["日本語", "表"],
    ["ハイフン", "A-B"]
  ])("**%s は拒否する**", (_name, value) => {
    expect(() => assertIdentifier(value, "ライブラリ名")).toThrow();
  });

  it("何の名前かをメッセージに含める（直し方が分かるように）", () => {
    expect(() => assertIdentifier("A;B", "ライブラリ名")).toThrow(/ライブラリ名/);
  });
});
