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
