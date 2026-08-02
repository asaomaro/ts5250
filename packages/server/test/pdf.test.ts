import { describe, it, expect } from "vitest";
import type { LogicalPage } from "@ts5250/scs";
import { renderSpoolPdf } from "../src/pdf.js";

const page = (lines: string[]): LogicalPage => ({ rows: lines.length, cols: Math.max(...lines.map((l) => l.length), 0), lines });
const isPdf = (buf: Buffer): boolean => buf.subarray(0, 5).toString("latin1") === "%PDF-";

describe("renderSpoolPdf", () => {
  it("SBCS の論理ページを PDF に変換できる（%PDF・非空）", async () => {
    const pdf = await renderSpoolPdf([page(["   Library List", "   QSYS   System Library"])]);
    expect(isPdf(pdf)).toBe(true);
    expect(pdf.length).toBeGreaterThan(500);
  });

  it("DBCS（日本語）を含むページも埋め込みフォントで生成できる", async () => {
    const pdf = await renderSpoolPdf([page(["   MYLIB   日本語テスト"])]);
    expect(isPdf(pdf)).toBe(true);
    // CJK フォント埋め込みで相応のサイズになる
    expect(pdf.length).toBeGreaterThan(1000);
  });

  it("複数ページは 1 ページより大きい PDF になる", async () => {
    const one = await renderSpoolPdf([page(["A"])]);
    const three = await renderSpoolPdf([page(["A"]), page(["B"]), page(["C"])]);
    expect(three.length).toBeGreaterThan(one.length);
  });

  it("フォントを読めない場合も Courier で PDF を生成する（degrade）", async () => {
    const warns: string[] = [];
    const pdf = await renderSpoolPdf([page(["ABC 123"])], { fontPath: "/nonexistent/font.ttc" }, (m) => warns.push(m));
    expect(isPdf(pdf)).toBe(true);
    expect(warns.length).toBeGreaterThanOrEqual(1);
  });

  it("空ページでも壊れない", async () => {
    const pdf = await renderSpoolPdf([]);
    expect(isPdf(pdf)).toBe(true);
  });
});
