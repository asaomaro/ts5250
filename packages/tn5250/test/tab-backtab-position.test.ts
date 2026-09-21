import { describe, it, expect } from "vitest";
import { tabPosition, backtabPosition, progressionTarget, progressionNumberOf } from "../src/screen/search.js";
import type { Cell, Field, ScreenSnapshot } from "../src/screen/types.js";

/**
 * **Tab・Backtab の行き先を ACS と同じに**（`FFT5250.nextNonByPassInputFieldPos` / `previousNonByPassInputFieldPos`。`20260921-hllapi-tab-acs`）。
 * 実機の ACS のコア（`scripts/acs-probe/backtab-home.txt`。ADJPGM）: 7,22 → 7,20・7,20 → 5,20・7,26 → 7,20。
 */
const COLS = 80;
const cell = (kind: Cell["kind"] = "sbcs"): Cell =>
  ({ char: " ", kind, color: "green", reverse: false, underline: false, blink: false, columnSeparator: false, nonDisplay: false }) as Cell;
const f = (index: number, row: number, over: Partial<Field> = {}): Field =>
  ({ index, row, col: 20, length: 6, protected: false, hidden: false, numeric: false, mdt: false, value: "", ...over }) as Field;
function snap(fields: Field[], so: [number, number][] = []): ScreenSnapshot {
  const cells = Array.from({ length: 24 }, () => Array.from({ length: COLS }, () => cell()));
  for (const [r, c] of so) cells[r - 1]![c - 1] = cell("so");
  return { sessionId: "s", rows: 24, cols: COLS, cursor: { row: 1, col: 1 }, keyboardLocked: false, cells, fields };
}
const pos = (row: number, col: number) => (row - 1) * COLS + col;
const rc = (p: number | undefined) => (p === undefined ? undefined : [Math.floor((p - 1) / COLS) + 1, ((p - 1) % COLS) + 1]);
const ADJ = () => [f(1, 3), f(2, 5), f(3, 7)];

describe("backtabPosition", () => {
  it("**欄の途中ならその欄の先頭**（ACS: 7,22 → 7,20）", () => {
    expect(rc(backtabPosition(snap(ADJ()), pos(7, 22)))).toEqual([7, 20]);
  });
  it("欄の 2 桁目からもその欄の先頭（1 つ手前が欄の先頭）", () => {
    expect(rc(backtabPosition(snap(ADJ()), pos(7, 21)))).toEqual([7, 20]);
  });
  it("欄の直後の桁からもその欄の先頭（ACS: 7,26 → 7,20）", () => {
    expect(rc(backtabPosition(snap(ADJ()), pos(7, 26)))).toEqual([7, 20]);
  });
  it("欄の先頭なら前の欄（ACS: 7,20 → 5,20）、先頭の欄の先頭なら最後の欄へ回り込む", () => {
    expect(rc(backtabPosition(snap(ADJ()), pos(7, 20)))).toEqual([5, 20]);
    expect(rc(backtabPosition(snap(ADJ()), pos(3, 20)))).toEqual([7, 20]);
  });
  it("保護欄と継続欄の 2 区間目以降は飛ばす", () => {
    const fields = [f(1, 3), f(2, 5, { protected: true }), f(3, 7, { continued: "first" }), f(4, 8, { continued: "last" })];
    expect(rc(backtabPosition(snap(fields), pos(9, 1)))).toEqual([7, 20]);
    expect(rc(backtabPosition(snap(fields), pos(7, 20)))).toEqual([3, 20]);
  });
  it("**欄の先頭で、そこへカーソル送りで来る欄があればそちら**（ACS は逆向きにも辿る）", () => {
    const fields = [f(1, 3, { cursorProgression: 3 }), f(2, 5), f(3, 7)];
    expect(rc(backtabPosition(snap(fields), pos(7, 20)))).toEqual([3, 20]);
  });
  it("先頭が SO の DBCS の欄（J）は SO の後ろへ、O の欄は先頭へ", () => {
    const j = [f(1, 3), f(2, 5, { dbcsType: "only" })];
    expect(rc(backtabPosition(snap(j, [[5, 20]]), pos(9, 1)))).toEqual([5, 21]);
    const o = [f(1, 3), f(2, 5, { dbcsType: "open" })];
    expect(rc(backtabPosition(snap(o, [[5, 20]]), pos(9, 1)))).toEqual([5, 20]);
  });
});

describe("tabPosition", () => {
  it("カーソルより後で始まる最初の入力欄。最後の後は先頭へ回り込む", () => {
    expect(rc(tabPosition(snap(ADJ()), pos(3, 22)))).toEqual([5, 20]);
    expect(rc(tabPosition(snap(ADJ()), pos(7, 20)))).toEqual([3, 20]);
  });
  it("**カーソルの下の欄のカーソル送りに従う**", () => {
    const fields = [f(1, 3, { cursorProgression: 3 }), f(2, 5), f(3, 7)];
    expect(rc(tabPosition(snap(fields), pos(3, 21)))).toEqual([7, 20]);
  });
  it("継続欄の 2 区間目以降・保護欄は飛ばす", () => {
    const fields = [f(1, 3, { continued: "first" }), f(2, 4, { continued: "last" }), f(3, 5, { protected: true }), f(4, 7)];
    expect(rc(tabPosition(snap(fields), pos(3, 21)))).toEqual([7, 20]);
  });
  it("入力欄が無ければ undefined", () => {
    expect(tabPosition(snap([f(1, 3, { protected: true })]), pos(1, 1))).toBeUndefined();
    expect(backtabPosition(snap([]), pos(1, 1))).toBeUndefined();
  });
});

/**
 * **カーソル送りの番号は、継続欄の 2 区間目以降を数えない並びで引く**（ACS `FFT5250.getStandardFieldList`。
 * `20260921-hllapi-tab-acs` の節目の独立点検の指摘。以前は `index`＝全区間を数える番号で引いていた）。
 * 欄: A(3 行・送り先 3) / B は継続欄（5 行 first・6 行 last）/ C(7 行) / D(9 行)。ACS の並びは [A, B, C, D] なので 3 番は C
 */
describe("カーソル送りの番号（継続欄が前にあるとき）", () => {
  const fields = () => [f(1, 3, { cursorProgression: 3 }), f(2, 5, { continued: "first" }), f(3, 6, { continued: "last" }), f(4, 7), f(5, 9)];
  it("Tab: 送り先 3 は C（`index` の 3＝B の最終区間ではない）", () => {
    expect(rc(tabPosition(snap(fields()), pos(3, 21)))).toEqual([7, 20]);
  });
  it("Backtab: C の先頭から、C（並びの 3 番）へ送る A へ戻る", () => {
    expect(rc(backtabPosition(snap(fields()), pos(7, 20)))).toEqual([3, 20]);
  });
  it("progressionTarget / progressionNumberOf は並びの番号で引き合う（継続欄の 2 区間目以降は番号を持たない）", () => {
    const fs = fields();
    expect(progressionTarget(fs, 3)?.index).toBe(4);
    expect(progressionNumberOf(fs, fs[3]!)).toBe(3);
    expect(progressionNumberOf(fs, fs[2]!)).toBeUndefined();
  });
});

describe("カーソルの手前が SO（J の欄の最初の字）からの Backtab", () => {
  it("J 欄の最初の字からは、その欄の先頭ではなく前の欄へ（ACS `processBacktab` の `IsSOChar(n-1)` なら 1 つ戻す）", () => {
    const s = snap([f(1, 3), f(2, 5, { dbcsType: "only" })], [[5, 20]]);
    expect(rc(backtabPosition(s, pos(5, 21)))).toEqual([3, 20]);
  });
});

describe("カーソル送りの送り先（節目 10 の独立点検で生き残った変異）", () => {
  it("**送り先が保護欄なら行かず、画面順の次へ倒す**（ACS `isByPassField`）", () => {
    const fields = [f(1, 3, { cursorProgression: 2 }), f(2, 5, { protected: true }), f(3, 7)];
    expect(rc(tabPosition(snap(fields), pos(3, 21)))).toEqual([7, 20]);
  });
  it("3 区間の継続欄（first・middle・last）は先頭の区間だけが並びに入る", () => {
    const fields = [
      f(1, 3, { cursorProgression: 2 }),
      f(2, 5, { continued: "first" }),
      f(3, 6, { continued: "middle" }),
      f(4, 7, { continued: "last" }),
      f(5, 9)
    ];
    // 標準の並びは [1, 2(first), 5] → 2 番は継続欄の先頭（5 行）。middle・last を数えていたら 2 番は 3（6 行）になる
    expect(rc(tabPosition(snap(fields), pos(3, 21)))).toEqual([5, 20]);
    expect(progressionNumberOf(fields as never, fields[4]!)).toBe(3);
  });
});
