import { describe, it, expect } from "vitest";
import { parseMnemonics, hasUnsupported } from "../src/hllapi-keys.js";

/**
 * HLLAPI のニーモニック解析。
 *
 * 表は 3270 由来で、**5250 に無いキーが混ざっている**（`PA1`〜`PA3` 等）。
 * 黙って捨てると「送ったつもりで送られていない」になるので、
 * `unsupported` として残ることを固定する。
 */
describe("普通の文字", () => {
  it("そのまま text になる", () => {
    expect(parseMnemonics("ABC")).toEqual([{ kind: "text", text: "ABC" }]);
  });

  it("**`@@` は文字の `@`**（表 3-3）", () => {
    expect(parseMnemonics("a@@b")).toEqual([{ kind: "text", text: "a@b" }]);
  });

  it("空文字は何も出さない", () => {
    expect(parseMnemonics("")).toEqual([]);
  });
});

describe("AID キー", () => {
  it("@E は Enter", () => {
    expect(parseMnemonics("@E")).toEqual([{ kind: "aid", key: "Enter" }]);
  });

  it("文字と AID が混ざる（`ABC@E` = ABC を打って Enter）", () => {
    expect(parseMnemonics("ABC@E")).toEqual([
      { kind: "text", text: "ABC" },
      { kind: "aid", key: "Enter" }
    ]);
  });

  it("@1〜@9 は F1〜F9、@a〜@o は F10〜F24", () => {
    expect(parseMnemonics("@3")).toEqual([{ kind: "aid", key: "F3" }]);
    expect(parseMnemonics("@a")).toEqual([{ kind: "aid", key: "F10" }]);
    expect(parseMnemonics("@o")).toEqual([{ kind: "aid", key: "F24" }]);
  });

  it("複合ニーモニック（@A@H = SysReq / @A@Q = Attn）", () => {
    expect(parseMnemonics("@A@H")).toEqual([{ kind: "aid", key: "SysReq" }]);
    expect(parseMnemonics("@A@Q")).toEqual([{ kind: "aid", key: "Attn" }]);
  });
});

describe("ローカル操作（ホストへ送らない）", () => {
  it("Tab / BackTab / Home / カーソル", () => {
    expect(parseMnemonics("@T")).toEqual([{ kind: "local", action: "tab" }]);
    expect(parseMnemonics("@B")).toEqual([{ kind: "local", action: "backtab" }]);
    expect(parseMnemonics("@0")).toEqual([{ kind: "local", action: "home" }]);
    expect(parseMnemonics("@U@V@L@Z").map((s) => (s.kind === "local" ? s.action : s.kind))).toEqual([
      "up", "down", "left", "right"
    ]);
  });
});

describe("**5250 に無いキーは黙って捨てない**", () => {
  it("PA1〜PA3（@x/@y/@z）は unsupported", () => {
    for (const m of ["@x", "@y", "@z"]) {
      expect(parseMnemonics(m)).toEqual([{ kind: "unsupported", mnemonic: m }]);
    }
  });

  it("知らないニーモニックも残す", () => {
    expect(parseMnemonics("@Q")).toEqual([{ kind: "unsupported", mnemonic: "@Q" }]);
  });

  it("末尾の裸の `@` も残す（捨てない）", () => {
    expect(parseMnemonics("A@")).toEqual([
      { kind: "text", text: "A" },
      { kind: "unsupported", mnemonic: "@" }
    ]);
  });

  it("知らない複合も残す", () => {
    expect(parseMnemonics("@A@Z")).toEqual([{ kind: "unsupported", mnemonic: "@A@Z" }]);
  });

  it("hasUnsupported が拾う（呼び出し側が rc=20 に落とす）", () => {
    expect(hasUnsupported(parseMnemonics("AB@E"))).toBe(false);
    expect(hasUnsupported(parseMnemonics("AB@x@E"))).toBe(true);
  });
});
