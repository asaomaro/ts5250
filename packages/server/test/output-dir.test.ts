import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readdirSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkOutputDir } from "../src/output-dir.js";

const tmp = (): string => mkdtempSync(join(tmpdir(), "outdir-"));
/** root は権限を無視するため、書込不可のテストは成立しない */
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

describe("checkOutputDir（PDF 出力先の保存時検証）", () => {
  it("正常なディレクトリは ok で、解決後の絶対パスを返す", async () => {
    const dir = tmp();
    const r = await checkOutputDir(dir);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.path).toBe(resolve(dir));
  });

  it("相対パスは絶対パスに解決される（cwd 基準であることを可視化する）", async () => {
    const r = await checkOutputDir(".");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.path).toBe(resolve("."));
  });

  it("存在しないディレクトリはエラーになり、作成もされない", async () => {
    const missing = join(tmp(), "no-such-dir");
    const r = await checkOutputDir(missing);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/見つかりません/);
    // 自動作成しない方針の担保
    expect(existsSync(missing)).toBe(false);
  });

  it("ファイルを指していたら「フォルダではありません」", async () => {
    const file = join(tmp(), "a.txt");
    writeFileSync(file, "x");
    const r = await checkOutputDir(file);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/フォルダではありません/);
  });

  it.skipIf(isRoot)("書き込めないディレクトリは「書き込めません」", async () => {
    const dir = tmp();
    chmodSync(dir, 0o500); // r-x: 読めるが書けない
    try {
      const r = await checkOutputDir(dir);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/書き込めません/);
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  it("検証後に一時ファイルを残さない", async () => {
    const dir = tmp();
    await checkOutputDir(dir);
    await checkOutputDir(dir);
    expect(readdirSync(dir)).toEqual([]);
  });
});
