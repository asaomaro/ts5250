import { describe, it, expect } from "vitest";
import { screenToText } from "../src/format.js";
import type { ScreenSnapshot, Cell } from "@as400web/core";

function cell(char: string): Cell {
  return {
    char,
    kind: "sbcs",
    color: "green",
    reverse: false,
    underline: false,
    blink: false,
    columnSeparator: false,
    nonDisplay: false
  };
}

function row(text: string, cols = 80): Cell[] {
  const r: Cell[] = [];
  for (let i = 0; i < cols; i++) r.push(cell(text[i] ?? " "));
  return r;
}

function makeSnap(): ScreenSnapshot {
  const cells: Cell[][] = [];
  for (let i = 0; i < 24; i++) cells.push(row(i === 0 ? "MAIN MENU" : i === 5 ? "  NAME:" : ""));
  return {
    sessionId: "s",
    rows: 24,
    cols: 80,
    cursor: { row: 6, col: 10 },
    keyboardLocked: false,
    cells,
    fields: [
      { index: 1, row: 6, col: 10, length: 10, protected: false, hidden: false, numeric: false, mdt: false, value: "TARO" },
      { index: 2, row: 7, col: 10, length: 10, protected: false, hidden: true, numeric: false, mdt: true, value: "" }
    ]
  };
}

describe("screenToText", () => {
  it("グリッドとフィールドを含む固定形式を出力する", () => {
    const t = screenToText(makeSnap());
    expect(t).toContain("=== Screen 24x80  cursor=(6,10)  keyboard=unlocked ===");
    expect(t).toContain("  1|MAIN MENU");
    expect(t).toContain("=== Fields ===");
    expect(t).toContain('#1 (6,10) len=10 input value="TARO"');
    expect(t).toContain("#2 (7,10) len=10 input hidden modified value=(masked)"); // hidden は値マスク
  });

  it("include で fields のみに絞れる", () => {
    const t = screenToText(makeSnap(), { include: ["fields"] });
    expect(t).not.toContain("  1|MAIN MENU");
    expect(t).toContain("=== Fields ===");
  });

  it("rows で行範囲を絞れる", () => {
    const t = screenToText(makeSnap(), { include: ["grid"], rows: { from: 6, to: 6 } });
    expect(t).toContain("  6|  NAME:");
    expect(t).not.toContain("  1|MAIN MENU");
  });

  it("DBCS 行でも桁位置がズレない（tail 空白埋め・SO/SI 空白）", () => {
    const snap = makeSnap();
    // 行1に A + SO + 日(lead/tail) + SI + B を配置（桁 1-6）
    const r0 = snap.cells[0]!;
    r0[0] = cell("A");
    r0[1] = { ...cell(" "), kind: "so" };
    r0[2] = { ...cell("日"), kind: "dbcs-lead" };
    r0[3] = { ...cell(""), kind: "dbcs-tail" };
    r0[4] = { ...cell(" "), kind: "si" };
    r0[5] = cell("B");
    const t = screenToText(snap, { include: ["grid"], rows: { from: 1, to: 1 } });
    const line = t.split("\n").find((l) => l.startsWith("  1|"))!;
    const body = line.slice(4);
    // 桁: A(1) 空[SO](2) 日[lead](3) 空[tail](4) 空[SI](5) B(6) — 各桁 1 文字ぶん
    expect(body.slice(0, 6)).toBe("A 日  B");
    expect(body.length).toBe(80); // 全 80 桁ぶんの文字数
  });

  it("hidden フィールドの値は決してテキストに出ない", () => {
    const snap = makeSnap();
    snap.fields[1]!.value = "SHOULD_NOT_APPEAR"; // マスク前の値が漏れないこと
    const t = screenToText(snap);
    expect(t).not.toContain("SHOULD_NOT_APPEAR");
  });

  it("GUI 構造体（選択フィールド/ウィンドウ/スクロールバー）をテキストに出力する", () => {
    const snap = makeSnap();
    snap.gui = {
      selectionFields: [
        {
          id: 1,
          row: 6,
          col: 4,
          kind: "radio",
          fieldType: 0x11,
          multiple: false,
          choices: [
            { index: 1, text: "YES", selected: true, available: true },
            { index: 2, text: "NO", selected: false, available: false }
          ]
        }
      ],
      windows: [
        { id: 2, row: 3, col: 5, width: 20, height: 6, title: "PROMPT", restrictCursor: true, pulldown: false }
      ],
      scrollBars: [{ id: 3, row: 4, col: 79, horizontal: false, total: 100, sliderPos: 10, size: 5 }]
    };
    const t = screenToText(snap);
    expect(t).toContain("=== GUI ===");
    expect(t).toContain("selection #1 (6,4) radio");
    expect(t).toContain('1. [x] "YES"');
    expect(t).toContain('2. [ ] (unavailable) "NO"');
    expect(t).toContain('window #2 (3,5) 20x6 "PROMPT"');
    expect(t).toContain("scrollbar #3 (4,79) vertical pos=10/100 size=5");
  });
});
