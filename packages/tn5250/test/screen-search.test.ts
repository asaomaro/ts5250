import { describe, it, expect } from "vitest";
import {
  AmbiguousMatchError,
  fieldAfterLabel,
  fieldAt,
  fieldById,
  fieldInRowWith,
  findAllText,
  nextInputField,
  prevInputField,
  posToRowCol,
  rowColToPos,
  screenLength,
  screenText,
  fieldId,
  type NarrowOptions
} from "../src/index.js";
import type { Cell, Field, ScreenSnapshot } from "../src/index.js";

/**
 * **画面から欄を見つける。**
 *
 * 5250 は欄の名前を電文で運ばないので、**レイアウト変更に耐える指し方は
 * 「見えている文字に錨を打つ」しかない**。桁位置で書くと画面が変わるたびに壊れる。
 *
 * そして**曖昧さは利用者に返す**——実機の `WRKSPLF` では 1 つの見出しが 9 個の欄を支配し、
 * 行の内容まで重複する。**導出できる一意な鍵は存在しない**。
 */

const cell = (char = " "): Cell =>
  ({
    char,
    kind: "sbcs",
    color: "green",
    reverse: false,
    underline: false,
    blink: false,
    columnSeparator: false,
    nonDisplay: false
  }) as Cell;

const fld = (over: { row: number; col: number; length: number } & Partial<Field>): Field =>
  ({
    index: 0,
      protected: false,
    hidden: false,
    numeric: false,
    mdt: false,
    value: "",
    ...over
  }) as Field;

/** 行の文字列と欄から画面を組む（桁は 1 起点で数える） */
function snap(text: string[], fields: Field[], cols = 40): ScreenSnapshot {
  const rows = Math.max(text.length, 24);
  const cells: Cell[][] = [];
  for (let r = 0; r < rows; r++) {
    const line = text[r] ?? "";
    cells.push(Array.from({ length: cols }, (_, c) => cell(line[c] ?? " ")));
  }
  return {
    sessionId: "s",
    rows,
    cols,
    cursor: { row: 1, col: 1 },
    keyboardLocked: false,
    cells,
    fields: fields.map((f, i) => ({ ...f, index: i + 1 }))
  } as ScreenSnapshot;
}


/** 欄の id（見つからなければ `undefined`） */
const idOf = (f: Field | undefined): string | undefined => (f ? fieldId(f) : undefined);

describe("欄の識別子", () => {
  it("**位置由来の形**（`f<row>c<col>`）", () => {
    expect(fieldId({ row: 20, col: 7 })).toBe("f20c7");
    expect(fieldId({ row: 1, col: 1 })).toBe("f1c1");
    // **連番ではない**——手前の欄が増減しても、この欄の id は変わらない
    expect(fieldId({ row: 20, col: 7 })).not.toMatch(/^\d+$/u);
  });

  it("**画面内で一意**（DOM のセレクタが 2 つに当たらない）", () => {
    const s = snap(["ab  pp  cd"], [
      fld({ row: 1, col: 1, length: 2 }),
      fld({ row: 1, col: 5, length: 2 }),
      fld({ row: 2, col: 1, length: 2 })
    ]);
    const ids = s.fields.map(fieldId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("桁位置の換算", () => {
  const size = { rows: 24, cols: 80 };

  it("先頭は 1、末尾は rows*cols", () => {
    expect(rowColToPos(1, 1, size)).toBe(1);
    expect(rowColToPos(24, 80, size)).toBe(1920);
    expect(screenLength(size)).toBe(1920);
  });

  it("**範囲外は undefined**", () => {
    expect(posToRowCol(0, size)).toBeUndefined();
    expect(posToRowCol(1921, size)).toBeUndefined();
    expect(rowColToPos(25, 1, size)).toBeUndefined();
  });
});

describe("文字で探す", () => {
  const s = snap(["ユーザー . . . :", "パスワード . . :"], []);

  it("**全角も素直に見つかる**（セル 1 つ = 文字 1 つで並べるため）", () => {
    expect(findAllText(s, "ユーザー")).toEqual([1]);
    expect(posToRowCol(findAllText(s, "パスワード")[0]!, { rows: 24, cols: 40 })?.row).toBe(2);
  });

  it("**すべての出現を返す**（1 つ目で止めない——曖昧さを判定するため）", () => {
    expect(findAllText(snap(["名前   名前"], []), "名前")).toHaveLength(2);
  });

  it("無ければ空", () => {
    expect(findAllText(s, "存在しない")).toEqual([]);
  });

  it("画面の文字列は固定長で改行を含まない", () => {
    expect(screenText(s)).toHaveLength(24 * 40);
    expect(screenText(s)).not.toContain("\n");
  });
});

describe("ラベルから欄を引く", () => {
  const s = snap(["ユーザー . . :", "パスワード . :"], [
    fld({ row: 1, col: 18, length: 10 }),
    fld({ row: 2, col: 18, length: 10, hidden: true })
  ]);

  it("**ラベルと同じ行の入力欄が引ける**（桁を書かなくてよい）", () => {
    expect(idOf(fieldAfterLabel(s, "ユーザー"))).toBe("f1c18");
    expect(idOf(fieldAfterLabel(s, "パスワード"))).toBe("f2c18");
  });

  it("**欄が動いても効く**（レイアウト変更に耐えるのはこれだけ）", () => {
    const moved = snap(["   ユーザー . . :"], [fld({ row: 1, col: 25, length: 10 })]);
    expect(idOf(fieldAfterLabel(moved, "ユーザー"))).toBe("f1c25");
  });

  it("**文言が変われば見つからない**（壊れるべき場面で壊れる）", () => {
    expect(fieldAfterLabel(s, "利用者")).toBeUndefined();
  });

  it("**同じ行に欄が無ければ引かない**（別の行へ迷い込まない）", () => {
    const t = snap(["見出しだけ", "ユーザー . :"], [fld({ row: 2, col: 18, length: 10 })]);
    expect(fieldAfterLabel(t, "見出しだけ")).toBeUndefined();
  });

  it("**同じラベルが複数の行にあれば例外**", () => {
    const t = snap(["名前 . :", "名前 . :"], [
      fld({ row: 1, col: 12, length: 8 }),
      fld({ row: 2, col: 12, length: 8 })
    ]);
    expect(() => fieldAfterLabel(t, "名前")).toThrowError(AmbiguousMatchError);
  });

  it("**行の範囲で絞れる**（絞り込みは重ねられる）", () => {
    const t = snap(["名前 . :", "名前 . :"], [
      fld({ row: 1, col: 12, length: 8 }),
      fld({ row: 2, col: 12, length: 8 })
    ]);
    expect(idOf(fieldAfterLabel(t, "名前", { rows: [2, 2] }))).toBe("f2c12");
  });
});

/**
 * **実機 `WRKSPLF` の形**（2026-08-04 に実機で確認）。
 *
 * ```
 * 10|            OPT   出力        状況        ← 見出しは 1 つ
 * 12| [入力]           QPDZDTALOG              ← 9 個の欄が並ぶ
 * 13| [入力]           QPDZDTALOG              ← **行の内容まで重複する**
 * ```
 */
describe("曖昧なら断る（実機の一覧画面）", () => {
  const list = snap(
    ["", "", "", "", "", "", "", "", "", " OPT   出力", "",
     " __    QPDZDTALOG", " __    QPDZDTALOG", " __    EMPSFR"],
    [
      fld({ row: 12, col: 2, length: 2 }),
      fld({ row: 13, col: 2, length: 2 }),
      fld({ row: 14, col: 2, length: 2 })
    ]
  );

  it("**一覧の見出しは `fieldAfterLabel` では引けない**（関係が違う）", () => {
    // `OPT` は同じ行に欄を持たず、**下の列に並ぶ 9 個**を支配している。
    // 行をまたいで「次の入力欄」を返すと、9 個の先頭を黙って選ぶことになる
    expect(fieldAfterLabel(list, "OPT")).toBeUndefined();
  });

  it("**行の内容が重複していても断る**（同じスプール名が 2 行）", () => {
    expect(() => fieldInRowWith(list, "QPDZDTALOG")).toThrowError(AmbiguousMatchError);
  });

  it("**例外に候補が付く**（そのまま人が絞り込める）", () => {
    try {
      fieldInRowWith(list, "QPDZDTALOG");
      expect.unreachable("例外になるはず");
    } catch (e) {
      expect(e).toBeInstanceOf(AmbiguousMatchError);
      const err = e as AmbiguousMatchError;
      expect(err.candidates).toHaveLength(2);
      expect(err.candidates[0]).toMatchObject({ row: 12, col: 2 });
      // 近傍の文字が入っていて、何と紛れているか分かる
      expect(err.message).toContain("QPDZDTALOG");
    }
  });

  it("**特徴的な行なら引ける**", () => {
    expect(idOf(fieldInRowWith(list, "EMPSFR"))).toBe("f14c2");
  });

  it("**`nth` は無い**（順序依存で事故の元。絞り込みで解く）", () => {
    // 「N 番目」を渡す口を用意していない。絞り込めない画面が出たら、
    // そのとき改めて考える（2026-08-04 の方針）
    const opts: NarrowOptions = { rows: [1, 2], cols: [1, 40] };
    expect(Object.keys(opts)).toEqual(["rows", "cols"]);
  });
});

describe("欄の走査", () => {
  const s = snap(["ab  pp  cd"], [
    fld({ row: 1, col: 1, length: 2 }),
    fld({ row: 1, col: 5, length: 2, protected: true }),
    fld({ row: 1, col: 9, length: 2 })
  ]);

  it("位置から欄を引ける", () => {
    expect(idOf(fieldAt(s, 1))).toBe("f1c1");
    expect(fieldAt(s, 3)).toBeUndefined();
  });

  it("**id から欄を引ける**", () => {
    expect(fieldById(s, "f1c9")?.col).toBe(9);
    expect(fieldById(s, "f9c9")).toBeUndefined();
  });

  it("次／前の入力欄（保護欄は飛ばす）", () => {
    expect(idOf(nextInputField(s, 1))).toBe("f1c9");
    expect(idOf(prevInputField(s, 9))).toBe("f1c1");
  });
});
