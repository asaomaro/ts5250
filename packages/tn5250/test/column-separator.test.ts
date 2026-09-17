import { describe, it, expect } from "vitest";
import { decodeAttribute } from "../src/screen/attributes.js";
import { columnSeparatorRuns } from "../src/screen/column-separator.js";
import type { Cell } from "../src/screen/types.js";

/**
 * **桁区切り（DSPATR(CS)）を ACS と同じ桁に立て、同じ位置に描く。**
 *
 * ACS（`PS5250.setAttributeToPlanes`）は 0x30–0x37 と 0x3F の 9 値で桁区切りの印を立て、
 * 画面に「桁ごとの点」（既定）を打つ。以前は 0x30–0x33 だけに立てていたうえ、描画側が
 * 黄・青緑を除外していたので、下線付きの青緑・黄の入力欄に点が一切出なかった
 * （利用者の記憶「入力可能エリアに 1 桁ずつ下線に . が付いて桁が分かる」がこれ）。
 */
describe("属性バイトの桁区切り（ACS の表）", () => {
  const CS = [0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x3f];

  it("0x30–0x37 と 0x3F に桁区切りが立つ", () => {
    for (const b of CS) expect(decodeAttribute(b).columnSeparator, `0x${b.toString(16)}`).toBe(true);
  });

  it("それ以外（0x20–0x2F・0x38–0x3E）には立たない", () => {
    for (let b = 0x20; b <= 0x3f; b++) {
      if (CS.includes(b)) continue;
      expect(decodeAttribute(b).columnSeparator, `0x${b.toString(16)}`).toBe(false);
    }
  });

  it("桁区切りを足しても色・下線・反転・非表示は変わらない", () => {
    expect(decodeAttribute(0x34)).toMatchObject({ color: "turquoise", underline: true, reverse: false });
    expect(decodeAttribute(0x35)).toMatchObject({ color: "turquoise", underline: true, reverse: true });
    expect(decodeAttribute(0x36)).toMatchObject({ color: "yellow", underline: true });
    expect(decodeAttribute(0x37)).toMatchObject({ color: "yellow", nonDisplay: true });
    expect(decodeAttribute(0x3f)).toMatchObject({ color: "blue", nonDisplay: true });
  });
});

function cell(cs: boolean, kind: Cell["kind"] = "sbcs"): Cell {
  return {
    char: " ", kind, color: "green", reverse: false, underline: false,
    blink: false, columnSeparator: cs, nonDisplay: false
  };
}

describe("columnSeparatorRuns", () => {
  it("行ごとに連なりを 1 始まりの行・桁と桁数で返す", () => {
    const row0 = [cell(false), cell(true), cell(true), cell(true), cell(false), cell(true)];
    const row1 = [cell(true), cell(true), cell(false), cell(false), cell(false), cell(false)];
    expect(columnSeparatorRuns([row0, row1])).toEqual([
      { row: 1, col: 2, len: 3 },
      { row: 1, col: 6, len: 1 }, // 行末まで続く連なりも閉じる
      { row: 2, col: 1, len: 2 }
    ]);
  });

  it("行をまたいで連なりを繋げない（行ごとに線の組が別になる）", () => {
    const row = [cell(false), cell(false), cell(true)];
    const next = [cell(true), cell(false), cell(false)];
    expect(columnSeparatorRuns([row, next])).toEqual([
      { row: 1, col: 3, len: 1 },
      { row: 2, col: 1, len: 1 }
    ]);
  });

  it("桁区切りの無い画面では空", () => {
    expect(columnSeparatorRuns([[cell(false), cell(false)]])).toEqual([]);
  });

  it("全角の後半桁も桁として数える（区切りは桁ごとに引く）", () => {
    const row = [cell(true, "dbcs-lead"), cell(true, "dbcs-tail"), cell(true)];
    expect(columnSeparatorRuns([row])).toEqual([{ row: 1, col: 1, len: 3 }]);
  });
});
