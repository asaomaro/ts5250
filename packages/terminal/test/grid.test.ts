import { describe, it, expect } from "vitest";
import type { GuiGridLine, ScreenSnapshot } from "@ts5250/tn5250";
import { renderFrame } from "../src/index.js";
import { gridOverlay } from "../src/render/grid.js";
import { sessionFrom, plain } from "./helpers.js";

const VP = { cols: 80, rows: 25 };

/** 画面を空白にして、罫線だけを持つ画面を作る */
async function withLines(lines: GuiGridLine[]): Promise<ScreenSnapshot> {
  const snap = (await sessionFrom("pub400-jobinfo")).snapshot();
  const cells = snap.cells.map((r) => r.map((c) => ({ ...c, kind: "sbcs" as const, char: " ", underline: false })));
  return { ...snap, cells, gui: { selectionFields: [], windows: [], scrollBars: [], gridLines: lines } };
}

const line = (o: Partial<GuiGridLine>): GuiGridLine => ({
  id: 1, minorType: 0x04, row: 3, col: 5, width: 6, height: 3, lineStyle: 0, color: 0x01, value1: 0, value2: 0, ...o
});

describe("DDS の罫線（グリッド罫線）", () => {
  it("箱は四隅が角の字になり、辺が ─ │ でつながる", async () => {
    const f = renderFrame(await withLines([line({})]), { viewport: VP, colorMode: "truecolor" });
    const rows = f.rows.map(plain);
    // 持ち主のセル: 上辺は 3 行目、下辺は最終行（5 行目）、左辺は 5 桁目、右辺は最終桁（10 桁目）
    expect(rows[2]!.slice(4, 10)).toBe("┌────┐");
    expect(rows[3]!.slice(4, 10)).toBe("│    │");
    expect(rows[4]!.slice(4, 10)).toBe("└────┘");
  });

  it("文字のあるセルは文字を優先する", async () => {
    const snap = await withLines([line({})]);
    const row = snap.cells[3]!;
    row[6] = { ...row[6]!, char: "X" };
    const f = renderFrame(snap, { viewport: VP, colorMode: "truecolor" });
    expect(plain(f.rows[3]!).slice(4, 10)).toBe("│ X  │");
  });

  it("内部罫線（行の間隔・桁の間隔）は交点が ┼ になる", async () => {
    const ov = gridOverlay(await withLines([line({ minorType: 0x07, height: 4, width: 6, value1: 2, value2: 3 })]))!;
    // 横罫は 2 行ごと（境界 2+... → 持ち主の行は上辺の 2 行下）、縦罫は 3 桁ごと
    const chars = [...ov.values()].map((c) => c.ch);
    expect(chars).toContain("┼");
  });

  it("線種: 太字は ━ ┃、二重は ═ ║", async () => {
    const heavy = gridOverlay(await withLines([line({ lineStyle: 0x01 })]))!;
    expect([...heavy.values()].map((c) => c.ch)).toEqual(expect.arrayContaining(["┏", "━", "┃"]));
    const dbl = gridOverlay(await withLines([line({ lineStyle: 0x02 })]))!;
    expect([...dbl.values()].map((c) => c.ch)).toEqual(expect.arrayContaining(["╔", "═", "║"]));
  });

  it("窓の穴に掛かる線は描かない", async () => {
    const ov = gridOverlay(await withLines([line({ holes: [{ row: 3, col: 5, width: 6, height: 3 }] })]))!;
    expect(ov.size).toBe(0);
  });

  it("罫線が無い画面は何も変えない", async () => {
    const snap = (await sessionFrom("pub400-jobinfo")).snapshot();
    expect(gridOverlay(snap)).toBeUndefined();
  });
});
