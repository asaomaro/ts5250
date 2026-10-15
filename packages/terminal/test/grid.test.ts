import { describe, it, expect } from "vitest";
import type { GuiGridLine, GuiWindow, ScreenSnapshot } from "@ts5250/tn5250";
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
  it("箱は縦罫を │ で描き、上辺は上線・下辺は下線で引く（罫線文字を行の中ほどに置かない）", async () => {
    const f = renderFrame(await withLines([line({})]), { viewport: VP, colorMode: "truecolor" });
    const rows = f.rows.map(plain);
    // 持ち主のセル: 上辺は 3 行目、下辺は最終行（5 行目）、左辺は 5 桁目、右辺は最終桁（10 桁目）
    expect(rows[2]!.slice(4, 10)).toBe("│    │");
    expect(f.rows[2]!).toContain(";53m");
    expect(rows[3]!.slice(4, 10)).toBe("│    │");
    expect(rows[4]!.slice(4, 10)).toBe("│    │");
    expect(f.rows[4]!).toContain(";4m");
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
    expect(gridOverlay(await withLines([line({ holes: [{ row: 3, col: 5, width: 6, height: 3 }] })]))).toBeUndefined();
  });

  it("罫線が無い画面は何も変えない", async () => {
    const snap = (await sessionFrom("pub400-jobinfo")).snapshot();
    expect(gridOverlay(snap)).toBeUndefined();
  });
});

describe("窓の枠と見出し", () => {
  const win = (o: Partial<GuiWindow>): GuiWindow => ({ id: 1, row: 5, col: 10, width: 6, height: 2, restrictCursor: false, pulldown: false, ...o });
  async function withWindow(w: GuiWindow): Promise<ScreenSnapshot> {
    const snap = await withLines([]);
    return { ...snap, gui: { ...snap.gui!, windows: [w] } };
  }

  it("文字の指定が無い枠は線で、窓の外側（行 row〜row+height+1・桁 col+1〜col+width+4）に出る", async () => {
    const f = renderFrame(await withWindow(win({ border: { cba: 0x22 } })), { viewport: VP, colorMode: "truecolor" });
    const rows = f.rows.map(plain);
    expect(rows[4]!.slice(10, 20)).toBe("┌────────┐");
    expect(rows[5]!.slice(10, 20)).toBe("│        │");
    expect(rows[7]!.slice(10, 20)).toBe("└────────┘");
  });

  it("枠文字の指定は属性ごと描く（反転の空白なら反転のセル）", async () => {
    const chars = { ulbc: " ", tbc: " ", urbc: " ", lbc: " ", rbc: " ", llbc: " ", bbc: " ", lrbc: " " };
    const snap = await withWindow(win({ border: { cba: 0x3b, chars } }));
    const f = renderFrame(snap, { viewport: VP, colorMode: "truecolor" });
    // 5 行目（添字 4）の先頭の枠のセルは反転（SGR 7）
    expect(f.rows[4]).toContain(";7m");
    expect(plain(f.rows[4]!).slice(10, 20)).toBe(" ".repeat(10));
  });

  it("見出しは枠の上辺の中央に出る（背面の文字を上書きする）", async () => {
    const snap = await withWindow(win({ border: { cba: 0x22 }, title: { text: "TTL", align: "center", footer: false, cba: 0x32 } }));
    const f = renderFrame(snap, { viewport: VP, colorMode: "truecolor" });
    expect(plain(f.rows[4]!).slice(10, 20)).toBe("┌──TTL───┐");
  });
});
