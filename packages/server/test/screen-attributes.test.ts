import { describe, it, expect } from "vitest";
import { screenToText, screenToAnsi, attributeRuns } from "../src/format.js";
import type { ScreenSnapshot, Cell } from "@ts5250/tn5250";

/**
 * **表示属性を端末で再現する**（`screenToAnsi`）と、**機械可読で返す**（`attributeRuns`）。
 *
 * 5250 の属性バイトが持つのは前景色と反転・下線・点滅・非表示・桁区切りで、
 * **セルごとの背景色は無い**。「背景に色が付いて見える」のは反転（前景色と地色の入れ替え）で、
 * ANSI でもそのまま `7` に写せば同じ見え方になる。
 */
const ESC = "\u001b";

function cell(char: string, over: Partial<Cell> = {}): Cell {
  return {
    char,
    kind: "sbcs",
    color: "green",
    reverse: false,
    underline: false,
    blink: false,
    columnSeparator: false,
    nonDisplay: false,
    ...over
  };
}

function snapOf(over: Partial<Cell> = {}, marked = 3): ScreenSnapshot {
  const cells: Cell[][] = [];
  for (let r = 0; r < 24; r++) {
    const row: Cell[] = [];
    const text = r === 0 ? "MAIN MENU" : "";
    for (let c = 0; c < 80; c++) {
      row.push(cell(text[c] ?? " ", r === 0 && c < marked ? over : {}));
    }
    cells.push(row);
  }
  return {
    sessionId: "s", rows: 24, cols: 80, cursor: { row: 1, col: 1 },
    keyboardLocked: false, cells, fields: []
  };
}

describe("screenToAnsi（人が端末で見る用）", () => {
  it("色を SGR に写す", () => {
    expect(screenToAnsi(snapOf({ color: "red" })).split("\n")[0]).toContain(`${ESC}[0;31m`);
  });

  it("反転・下線・点滅を足す（反転が 5250 でいう背景色）", () => {
    const t = screenToAnsi(snapOf({ color: "blue", reverse: true, underline: true, blink: true }));
    expect(t.split("\n")[0]).toContain(`${ESC}[0;34;7;4;5m`);
  });

  it("7 色すべてに対応がある", () => {
    const want: [Cell["color"], number][] = [
      ["green", 32], ["white", 37], ["red", 31], ["turquoise", 36],
      ["yellow", 33], ["pink", 35], ["blue", 34]
    ];
    for (const [color, code] of want) {
      expect(screenToAnsi(snapOf({ color })).split("\n")[0]).toContain(`${ESC}[0;${code}m`);
    }
  });

  it("行末で属性を戻す（次の行へ色を持ち越さない）", () => {
    for (const line of screenToAnsi(snapOf({ color: "red" })).split("\n")) {
      expect(line.endsWith(`${ESC}[0m`)).toBe(true);
    }
  });

  it("属性が変わらない間はエスケープを繰り返さない", () => {
    const line = screenToAnsi(snapOf({ color: "red" })).split("\n")[0]!;
    // 赤の 3 桁で 1 回、緑に戻るところで 1 回の計 2 回だけ
    // （1 桁ごとに出すと 80 桁の行が escape だらけになる）
    expect(line.split(`${ESC}[0;`).length - 1).toBe(2);
  });

  it("非表示は空白にする（ANSI の conceal は当てにしない）", () => {
    expect(screenToAnsi(snapOf({ nonDisplay: true })).split("\n")[0]).not.toContain("MAI");
  });

  it("エスケープを外すと通常のグリッドと同じ（桁位置を崩さない）", () => {
    const plain = screenToText(snapOf(), { include: ["grid"] }).split("\n")[1]!;
    const ansi = screenToAnsi(snapOf()).split("\n")[0]!;
    expect(ansi.replace(/\u001b\[[0-9;]*m/gu, "")).toBe(plain);
  });

  it("行範囲の指定に従う", () => {
    expect(screenToAnsi(snapOf(), { rows: { from: 3, to: 5 } }).split("\n")).toHaveLength(3);
  });
});

describe("attributeRuns（LLM が読む用）", () => {
  it("既定の見た目（緑・装飾なし）は返さない", () => {
    // 画面の大半がこれなので、残すと「どこが強調されているか」が埋もれる
    expect(attributeRuns(snapOf())).toEqual([]);
  });

  it("変わり目だけを run で返す", () => {
    expect(attributeRuns(snapOf({ color: "red", reverse: true })))
      .toEqual([{ row: 1, col: 1, len: 3, color: "red", reverse: true }]);
  });

  it("立っていない属性は載せない", () => {
    expect(attributeRuns(snapOf({ color: "white" }))[0]).toEqual({ row: 1, col: 1, len: 3, color: "white" });
  });

  it("桁区切り（ANSI に相当が無い）も残す", () => {
    expect(attributeRuns(snapOf({ columnSeparator: true }))[0])
      .toEqual({ row: 1, col: 1, len: 3, color: "green", columnSeparator: true });
  });

  it("行範囲の指定に従う", () => {
    expect(attributeRuns(snapOf({ color: "red" }), { rows: { from: 2, to: 5 } })).toEqual([]);
  });

  it("テキストの Attributes セクションにも出る", () => {
    const t = screenToText(snapOf({ color: "red", underline: true }), { include: ["attributes"] });
    expect(t).toContain("=== Attributes ===");
    expect(t).toContain("(1,1) len=3 red underline");
  });

  it("属性が無ければ (none)", () => {
    expect(screenToText(snapOf(), { include: ["attributes"] })).toContain("(none)");
  });
});
