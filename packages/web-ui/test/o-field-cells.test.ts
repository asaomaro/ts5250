import { describe, it, expect } from "vitest";
import { toCells, fromCells, overwrite, insert, del, backspace, eraseToEnd, cellOfEntry, entryOfCell, type OCell, type OResult } from "../src/composables/oFieldCells.js";
import { SO_MARK, SI_MARK } from "../src/composables/fieldValidate.js";

/**
 * **O 欄のセルの編集**（`20260928-o-field-cells`）。期待値は実機の ACS のコアに同じ打鍵をさせてホストが受け取ったバイト列
 * （DSM の OEDIT・`scripts/acs-probe/o-field-edit.txt`。24 通り）を、セルの記法に直したもの: `{` = SO、`}` = SI、全角は字、半角は字、空きは落とす。
 * 例: `0e0fe7400e0f` → `{}X {}`
 */
const L = 12;
type Step = { at?: number; type?: string; ins?: string; del?: true; bs?: true; eof?: true };

function show(cells: readonly OCell[]): string {
  let s = "";
  for (const c of cells) s += c.k === "so" ? "{" : c.k === "si" ? "}" : c.k === "tail" ? "" : c.ch;
  return s.replace(/ +$/, "");
}

/** 手順を流す。エラー・何もしないの手順は値とカーソルを変えない（`errors` に積む） */
function run(steps: Step[]): { cells: OCell[]; cursor: number; errors: (number | "noop")[] } {
  let cells = toCells([], L);
  let cursor = 0;
  const errors: (number | "noop")[] = [];
  const take = (r: OResult): void => {
    if ("error" in r) errors.push(r.error);
    else if ("noop" in r) errors.push("noop");
    else [cells, cursor] = [r.cells, r.cursor];
  };
  for (const s of steps) {
    if (s.at !== undefined) cursor = s.at;
    for (const ch of s.type ?? "") take(overwrite(cells, cursor, ch));
    for (const ch of s.ins ?? "") take(insert(cells, cursor, ch));
    if (s.del) take(del(cells, cursor));
    if (s.bs) take(backspace(cells, cursor));
    if (s.eof) cells = eraseToEnd(cells, cursor);
  }
  return { cells, cursor, errors };
}

describe("上書き（ACS の実測 1 巡目）", () => {
  it.each([
    ["ABCD の先頭に あ（S S S S → SO あ SI）", [{ type: "ABCD" }, { at: 0, type: "あ" }], "{あ}"],
    ["あ の SI に い（あ い SI）", [{ type: "あ" }, { at: 3, type: "い" }], "{あい}"],
    ["あ の SI に X（SI X）", [{ type: "あ" }, { at: 3, type: "X" }], "{あ}X"],
    ["あい の あ に X（SI X 空白 SO）", [{ type: "あい" }, { at: 1, type: "X" }], "{}X {}"],
    ["あ の SO に X（X 空白 SO）", [{ type: "あ" }, { at: 0, type: "X" }], "X {}"],
    ["AB の先頭に あ", [{ type: "AB" }, { at: 0, type: "あ" }], "{あ}"],
    ["あX の SO に い（SO い）", [{ type: "あX" }, { at: 0, type: "い" }], "{い}X"]
  ] as const)("%s", (_n, steps, want) => {
    const r = run(steps as unknown as Step[]);
    expect(show(r.cells)).toBe(want);
    expect(r.errors).toEqual([]);
  });

  it("**後ろの SO の次が全角なら、その最初の字を潰して並びを分ける**（S S S O D → SO 字 SI 空白 SO）", () => {
    const r = run([{ type: "ABC" }, { at: 3, type: "あい" }, { at: 0, type: "う" }]);
    expect(show(r.cells)).toBe("{う} {い}");
  });

  it("後ろの SO の次が SI（空の組）なら空白にする（S S S O I → SO 字 SI 空白）", () => {
    const r = run([{ type: "ABC" }, { at: 3, type: "あ" }, { at: 4, del: true }, { at: 0, type: "う" }]);
    expect(show(r.cells)).toBe("{う}");
  });

  it("**欄の最後のセルの SI にカーソルが進んだら、欄の次へ進む**（ACS: `IsSIChar(c+adv) && IsFA(c+adv+1)`）", () => {
    let cells = toCells([], 6);
    let cursor = 0;
    for (const ch of "あい") {
      const r = overwrite(cells, cursor, ch);
      if (!("cells" in r)) throw new Error("rejected");
      [cells, cursor] = [r.cells, r.cursor];
    }
    expect(show(cells)).toBe("{あい}");
    expect(cursor).toBe(6);
  });

  it("**11 桁目の全角は 0005**（S S E）・値は変わらない", () => {
    const r = run([{ type: "ABCDEFGHIJK" }, { at: 10, type: "あ" }]);
    expect(show(r.cells)).toBe("ABCDEFGHIJK");
    expect(r.errors).toEqual([0x05]);
  });

  it("全角を続けて打つと並びが延びる（SI の上で次の字。カーソルは SI の上）", () => {
    const r = run([{ type: "あい" }]);
    expect(show(r.cells)).toBe("{あい}");
    expect(r.cursor).toBe(5);
  });
});

describe("挿入（ACS の実測 2 巡目）", () => {
  it.each([
    ["AB の B に あ（SO あ SI）", [{ type: "AB" }, { at: 1, ins: "あ" }], "A{あ}B"],
    ["**(i) あB の B に い → 別の並び**", [{ type: "あB" }, { at: 4, ins: "い" }], "{あ}{い}B"],
    ["**(ii) あい の あ に X → 空の SO/SI**", [{ type: "あい" }, { at: 1, ins: "X" }], "{}X{あい}"],
    ["あ の SI に い（並びを延ばす）", [{ type: "あ" }, { at: 3, ins: "い" }], "{あい}"],
    ["あ の SO に X（SO の前）", [{ type: "あ" }, { at: 0, ins: "X" }], "X{あ}"],
    ["あ の SI に X（SI の後ろ）", [{ type: "あ" }, { at: 3, ins: "X" }], "{あ}X"],
    ["あ の SO に い（SO の直後）", [{ type: "あ" }, { at: 0, ins: "い" }], "{いあ}"]
  ] as const)("%s", (_n, steps, want) => {
    const r = run(steps as unknown as Step[]);
    expect(show(r.cells)).toBe(want);
    expect(r.errors).toEqual([]);
  });

  it("**満杯の欄への挿入は 0012**・値は変わらない", () => {
    const r = run([{ type: "ABCDEFGHIJKL" }, { at: 1, ins: "X" }]);
    expect(show(r.cells)).toBe("ABCDEFGHIJKL");
    expect(r.errors).toEqual([0x12]);
  });

  it("カーソルが最終のセルなら空いていても 0012", () => {
    expect(run([{ at: 11, ins: "X" }]).errors).toEqual([0x12]);
  });

  it("(i) で入った後は ACS と同じく空きが 2 桁少ない（続けて 4 桁の挿入は 0012）", () => {
    // {あ}{い}B は 9 桁。残り 3 桁に SO 字 SI（4 桁）は入らない
    const r = run([{ type: "あB" }, { at: 4, ins: "い" }, { at: 8, ins: "う" }]);
    expect(r.errors).toEqual([0x12]);
  });
});

describe("削除・後退・消去（ACS の実測 3 巡目）", () => {
  it.each([
    ["**あ で Delete → 空の SO/SI が残る**", [{ type: "あ" }, { at: 1, del: true }], "{}", []],
    ["SO で Delete（単独の SO）→ 0065", [{ type: "あ" }, { at: 0, del: true }], "{あ}", [0x65]],
    ["あX の X で Backspace（直前が単独の SI）→ 0065", [{ type: "あX" }, { at: 4, bs: true }], "{あ}X", [0x65]],
    ["あい の い で Backspace（全角 2 桁）", [{ type: "あい" }, { at: 3, bs: true }], "{い}", []],
    ["ABあ の SO から Erase EOF（並びごと消える）", [{ type: "ABあ" }, { at: 2, eof: true }], "AB", []],
    ["**あいう の い から Erase EOF → SI を置く**", [{ type: "あいう" }, { at: 3, eof: true }], "{あ}", []],
    ["SI で Delete（次が SO でない）→ 0065", [{ type: "あ" }, { at: 3, del: true }], "{あ}", [0x65]],
    ["**継ぎ目の SI で Delete → SI SO を消して並びが繋がる**", [{ type: "あ" }, { at: 4, type: "い" }, { at: 3, del: true }], "{あい}", []]
  ] as const)("%s", (_n, steps, want, errors) => {
    const r = run(steps as unknown as Step[]);
    expect(show(r.cells)).toBe(want);
    expect(r.errors).toEqual(errors);
  });

  it("**表のどの行にも当たらない形は黙って何もしない**（半角・SI の上に全角——S I）", () => {
    const cells: OCell[] = [{ k: "sb", ch: "A" }, { k: "si", ch: "" }, ...Array.from({ length: 10 }, () => ({ k: "sb" as const, ch: " " }))];
    expect(overwrite(cells, 0, "あ")).toEqual({ noop: true });
  });

  it("**空の SO/SI の組は Delete で 2 桁まとめて消える**（ACS `processDeleteChar`: SO の次が SI）", () => {
    const r = run([{ type: "あ" }, { at: 1, del: true }, { at: 0, del: true }]);
    expect(show(r.cells)).toBe("");
    expect(r.errors).toEqual([]);
  });

  it("欄の先頭の Backspace は 0005", () => {
    expect(run([{ type: "A" }, { at: 0, bs: true }]).errors).toEqual([0x05]);
  });
});

describe("値とセルの行き来", () => {
  it("印のある値はそのまま、無い値（古い値）は全角の連なりを SO/SI で挟む", () => {
    expect(show(toCells([SO_MARK, SI_MARK, "X"], L))).toBe("{}X");
    expect(show(toCells(["あ", "い", "X"], L))).toBe("{あい}X");
    expect(fromCells(toCells(["あ", "X"], 6))).toEqual([SO_MARK, "あ", SI_MARK, "X", " "]);
  });

  it("要素の添字とセルの桁（全角は 2 桁、後半の桁は前半の要素へ）", () => {
    const chars = [SO_MARK, "あ", SI_MARK, "X"];
    expect([0, 1, 2, 3, 4].map((i) => cellOfEntry(chars, i))).toEqual([0, 1, 3, 4, 5]);
    expect([0, 1, 2, 3, 4, 5].map((c) => entryOfCell(chars, c))).toEqual([0, 1, 1, 2, 3, 4]);
  });

  it("**印の無い値（暗黙の並び）も SO/SI の桁を数える**（並びの最初の全角は SO の次、並びの直後の半角は SI の次、閉じていない終わりは SI の桁）", () => {
    const chars = ["A", "あ", "い", "B"];
    expect([0, 1, 2, 3].map((i) => cellOfEntry(chars, i))).toEqual([0, 2, 4, 7]);
    expect(cellOfEntry(["あ", "い"], 2)).toBe(5);
  });

  it("前半・後半の組が崩れたセルは空きに戻す", () => {
    expect(fromCells([{ k: "lead", ch: "　" }, { k: "sb", ch: "A" }])).toEqual([" ", "A"]);
  });
});
