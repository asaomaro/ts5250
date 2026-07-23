import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpoolReport } from "@as400web/core";
import { handleReport } from "../src/printer-output.js";

const report: SpoolReport = {
  id: "spool-1",
  pages: [{ rows: 1, cols: 10, lines: ["Library List"] }],
  raw: new Uint8Array(0)
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "spool-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("handleReport", () => {
  it("autoPdfDir が指定されると PDF を保存する", async () => {
    const r = await handleReport(report, { autoPdfDir: dir }, () => {}, () => 1_700_000_000_000);
    expect(r.pdfPath).toBeDefined();
    const files = readdirSync(dir).filter((f) => f.endsWith(".pdf"));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\d{8}-\d{6}-spool-1\.pdf$/);
    expect(readFileSync(join(dir, files[0]!)).subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("設定が無ければ何もしない", async () => {
    const r = await handleReport(report, {});
    expect(r).toEqual({});
    expect(readdirSync(dir)).toHaveLength(0);
  });

  it("autoPrint は lp 不在なら warn して printed=false（degrade）", async () => {
    const warns: string[] = [];
    const r = await handleReport(report, { autoPrint: "PRT1" }, (m) => warns.push(m));
    // この環境に lp が無いので false（lp があるサーバーでのみ true）
    expect(r.printed).toBe(false);
    expect(warns.some((w) => /lp/.test(w))).toBe(true);
  });
});

/**
 * **ホスト変換済み（HPT）の印刷データはそのまま流す。**
 *
 * これが「本来の印刷経路」——書式・フォント・改ページはホストが決めたまま。
 * PDF へ起こす経路（既定）は当アプリの再現なので体裁が元と異なる。
 * 中身はプリンターの言語（PCL 等）なので、当アプリは解釈も PDF 化もしない。
 */
describe("handleReport — ホスト変換済み（rawPrint）", () => {
  /** HPT で受けた帳票: ページは無く raw だけ持つ */
  const rawReport: SpoolReport = {
    id: "spool-hpt-1",
    pages: [],
    raw: Uint8Array.from([0x1b, 0x45, 0x41, 0x42, 0x43]) // ESC E "ABC"（PCL）
  };

  it("PDF は作らない（作れないので理由を残す）", async () => {
    const r = await handleReport(rawReport, { autoPdfDir: dir, rawPrint: true }, () => {}, () => 1);
    expect(r.pdfPath, "PDF は作らない").toBeUndefined();
    expect(r.pdfError, "理由を残す").toMatch(/PDF/);
    expect(readdirSync(dir), "ディレクトリにも書かない").toHaveLength(0);
  });

  it("autoPrint が無ければ何も起きない", async () => {
    const r = await handleReport(rawReport, { rawPrint: true }, () => {}, () => 1);
    expect(r.printed).toBeUndefined();
  });

  /**
   * lp はこの環境に無いので「印刷を試みて失敗した」ところまでを見る。
   * 大事なのは **PDF 経路へ落ちないこと**——落ちると本来の書式が失われる。
   */
  it("印刷は試みる（PDF 経路へ落ちない）", async () => {
    const warns: string[] = [];
    const r = await handleReport(
      rawReport,
      { autoPrint: "PRT1", rawPrint: true },
      (m) => warns.push(m),
      () => 1
    );
    expect(r.printer).toBe("PRT1");
    expect(r.printed, "lp が無い環境なので失敗する").toBe(false);
    // PDF 生成に触れていない（触れていれば「PDF 生成に失敗」が出る）
    expect(warns.join(" ")).not.toMatch(/PDF 生成/);
  });

  it("rawPrint でなければ従来どおり PDF を作る", async () => {
    const r = await handleReport(report, { autoPdfDir: dir }, () => {}, () => 1);
    expect(r.pdfPath).toBeDefined();
    expect(r.pdfError).toBeUndefined();
  });
});
