import { describe, it, expect } from "vitest";
import { dbcsByteLength, columnView, dbcsViewLayout, SO_MARK, SI_MARK, hasShiftMarks } from "../src/composables/fieldValidate.js";

/**
 * **O 欄の明示の並び**（`20260928-o-field-cells`）: 値に SO/SI の印があれば、印を SO/SI の桁として数え・描き、暗黙の SO/SI を足さない。
 * 印の無い値（E・J・G 欄、全角の無い O 欄）は従来どおり
 */
describe("明示の並びの桁数・列ビュー", () => {
  it("**桁数は印 1・全角 2・ほか 1**（暗黙の SO/SI を足さない）", () => {
    expect(dbcsByteLength(SO_MARK + "あ" + SI_MARK + SO_MARK + "う" + SI_MARK + "X")).toBe(9);
    expect(dbcsByteLength(SO_MARK + SI_MARK + "X")).toBe(3);
    expect(dbcsByteLength("あう" + "X")).toBe(7); // 印の無い値は従来どおり（SO あう SI X）
  });

  it("**列ビューは印の位置に SO/SI の印を描く**", () => {
    expect(columnView(SO_MARK + "あ" + SI_MARK + SO_MARK + "う" + SI_MARK + "X", "{", "}")).toBe("{あ}{う}X");
    expect(columnView(SO_MARK + SI_MARK + "X", "{", "}")).toBe("{}X");
  });

  it("**キャレットは印の位置にも対応する**（論理の添字＝セルの並びの添字）", () => {
    const lay = dbcsViewLayout(SO_MARK + "あ" + SI_MARK + "X", "{", "}");
    expect(lay.view).toBe("{あ}X");
    expect([0, 1, 2, 3, 4].map((i) => lay.caretOf(i))).toEqual([0, 1, 2, 3, 4]);
    expect(lay.columnsBefore(lay.caretOf(2))).toBe(3); // SI の桁は 3 桁目（SO 1＋全角 2）
    expect(lay.columns).toBe(5);
  });

  it("`hasShiftMarks` は印があるときだけ真", () => {
    expect(hasShiftMarks(SO_MARK + "あ" + SI_MARK)).toBe(true);
    expect(hasShiftMarks("あX")).toBe(false);
  });
});
