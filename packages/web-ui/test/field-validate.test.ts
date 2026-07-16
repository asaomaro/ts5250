import { describe, it, expect } from "vitest";
import { acceptsChar, dbcsByteLength, columnView, dbcsViewLayout } from "../src/composables/fieldValidate.js";
import type { Field } from "@as400web/core";

function fld(o: Partial<Field>): Field {
  return { index: 1, row: 1, col: 1, length: 10, protected: false, hidden: false, numeric: false, mdt: false, value: "", ...o };
}

describe("acceptsChar フィールド型ごとの入力ルール", () => {
  it("数値: 数字・小数点・符号を許可し、英字と全角を拒否", () => {
    const f = fld({ numeric: true });
    for (const ch of ["0", "9", ".", "-", "+"]) expect(acceptsChar(f, ch)).toBe(true);
    for (const ch of ["A", "z"]) expect(acceptsChar(f, ch)).toBe(false); // 英字不可
    expect(acceptsChar(f, "日")).toBe(false); // 全角不可
  });

  it("A（SBCS/英数字）: 半角を許可し、DBCS(全角)を拒否", () => {
    const f = fld({}); // dbcsType 無し = SBCS
    expect(acceptsChar(f, "A")).toBe(true);
    expect(acceptsChar(f, "1")).toBe(true);
    expect(acceptsChar(f, "日")).toBe(false); // ← A は DBCS を入力できない
    expect(acceptsChar(f, "あ")).toBe(false);
  });

  it("O（open）: SBCS も DBCS も許可", () => {
    const f = fld({ dbcsType: "open" });
    expect(acceptsChar(f, "A")).toBe(true);
    expect(acceptsChar(f, "日")).toBe(true);
  });

  it("J（pure DBCS）: DBCS を許可し、SBCS を拒否", () => {
    const f = fld({ dbcsType: "pure" });
    expect(acceptsChar(f, "日")).toBe(true);
    expect(acceptsChar(f, "あ")).toBe(true);
    expect(acceptsChar(f, "A")).toBe(false); // ← J は SBCS を入力できない
    expect(acceptsChar(f, "1")).toBe(false);
  });

  it("either: SBCS も DBCS も許可", () => {
    const f = fld({ dbcsType: "either" });
    expect(acceptsChar(f, "A")).toBe(true);
    expect(acceptsChar(f, "日")).toBe(true);
  });
});

describe("dbcsByteLength 送信バイト長の見積り（SO/SI・DBCS 2 バイト込み）", () => {
  it("SBCS は 1 文字 1 バイト", () => {
    expect(dbcsByteLength("")).toBe(0);
    expect(dbcsByteLength("ABC")).toBe(3);
  });

  it("DBCS 連続ランは SO+2×N+SI（SO/SI を 1 ペア共有）", () => {
    expect(dbcsByteLength("あ")).toBe(4); // SO+2+SI
    expect(dbcsByteLength("あい")).toBe(6); // SO+4+SI（1 ペア共有）
    expect(dbcsByteLength("あいう")).toBe(8); // SO+6+SI
  });

  it("SBCS↔DBCS 切替ごとに SO/SI が入る", () => {
    expect(dbcsByteLength("AあB")).toBe(6); // A + SO+2 + SI+B
    expect(dbcsByteLength("あAい")).toBe(9); // SO+2+SI + A + SO+2+SI
  });

  it("例: 表示 ABC[SO]あ[SI]DEF ＝ データ ABC あDEF は 11 バイト", () => {
    // A B C 空白 =4, あ=SO+2, D で SI, DEF=3 → 4 + 3 + 1 + 3 = 11
    expect(dbcsByteLength("ABC あDEF")).toBe(11);
  });
});

describe("columnView 表示用の SO/SI スペース挿入", () => {
  it("SBCS のみは変化しない", () => {
    expect(columnView("ABC")).toBe("ABC");
    expect(columnView("")).toBe("");
  });

  it("DBCS ランの前後に SO/SI スペースを挿入（連続は 1 ペア）", () => {
    expect(columnView("あ")).toBe(" あ "); // SO+あ+SI
    expect(columnView("あい")).toBe(" あい "); // SO+あい+SI（共有）
  });

  it("例: データ ABC あDEF → 表示 ABC[SO]あ[SI]DEF（SO/SI が半角スペース）", () => {
    expect(columnView("ABC あDEF")).toBe("ABC  あ DEF"); // 実スペース+SO / SI
  });

  it("SO/SI マーク指定（showShiftMarks の { }）で SO=左・SI=右に置換", () => {
    expect(columnView("Aあ", "{", "}")).toBe("A{あ}");
    expect(columnView("あい", "{", "}")).toBe("{あい}");
    expect(columnView("ABC", "{", "}")).toBe("ABC"); // DBCS 無しは不変
  });
});

describe("dbcsViewLayout 論理⇔列ビューのカーソルマッピング", () => {
  it("論理カーソルは SO/SI をスキップした列位置に対応する", () => {
    const { view, caretOf } = dbcsViewLayout("Aあ"); // 列ビュー "A あ "（A, SO, あ, SI）
    expect(view).toBe("A あ ");
    expect(caretOf(0)).toBe(0); // A の前
    expect(caretOf(1)).toBe(2); // あ の前（SO の桁=1 をスキップ）
    expect(caretOf(2)).toBe(3); // 末尾（あ の直後・末尾 SI の前。SI を飛び越えない）
  });

  it("列ビューの caret を論理カーソルへスナップ（往復）", () => {
    const { logicalOf } = dbcsViewLayout("Aあ");
    expect(logicalOf(0)).toBe(0);
    expect(logicalOf(2)).toBe(1); // あ 桁 → 論理 1
    expect(logicalOf(3)).toBe(2); // 末尾（あ の直後）
  });

  it("columnsBefore は DBCS を 2 桁として数える", () => {
    const { columnsBefore } = dbcsViewLayout("Aあ"); // view="A あ "（A, SO, あ, SI）
    expect(columnsBefore(2)).toBe(2); // "A "(SO) までで 1+1=2 桁
    expect(columnsBefore(3)).toBe(4); // "A あ" までで 1+1+2=4 桁（あ の直後）
    expect(columnsBefore(4)).toBe(5); // "A あ "（末尾 SI 込み）で 5 桁
  });
});
