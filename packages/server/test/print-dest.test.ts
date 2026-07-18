import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkPrintDest } from "../src/print-dest.js";

/**
 * 宛先チェックは**警告に留める**（保存は止めない）。プリンターは実際に印刷して確かめられず、
 * 確認手段が無い環境もあるため、「宛先が無い」のか「確認できない」のかを区別して伝える。
 *
 * 実環境の lp/lpstat に依存しないよう、PATH を差し替えた偽コマンドで検証する。
 */
const realPath = process.env["PATH"];
afterEach(() => {
  process.env["PATH"] = realPath;
});

/** PATH をこのディレクトリだけにして、指定したコマンドだけを置く */
function fakeBin(cmds: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "bin-"));
  for (const [name, body] of Object.entries(cmds)) {
    const p = join(dir, name);
    writeFileSync(p, `#!/bin/sh\n${body}\n`);
    chmodSync(p, 0o755);
  }
  process.env["PATH"] = dir;
  return dir;
}

describe("checkPrintDest（自動印刷の宛先チェック）", () => {
  it("lp が無ければ「自動印刷が動きません」と警告する", async () => {
    fakeBin({}); // 何も置かない
    const r = await checkPrintDest("Office");
    expect(r.warn).toMatch(/lp コマンドが見つかりません/);
    expect(r.warn).toContain("Office");
  });

  it("lp はあるが lpstat が無ければ「確認できませんでした」と警告する", async () => {
    fakeBin({ lp: "exit 0" });
    const r = await checkPrintDest("Office");
    expect(r.warn).toMatch(/確認できませんでした/);
    expect(r.warn).toMatch(/lpstat/);
  });

  it("宛先が引ければ警告なし", async () => {
    fakeBin({ lp: "exit 0", lpstat: "exit 0" });
    expect(await checkPrintDest("Office")).toEqual({});
  });

  it("宛先が引けなければ「見つかりません」と警告する", async () => {
    fakeBin({ lp: "exit 0", lpstat: "exit 1" });
    const r = await checkPrintDest("Typo");
    expect(r.warn).toMatch(/「Typo」が見つかりません/);
  });

  it("応答が遅い宛先は打ち切って警告する（保存操作をブロックしない）", async () => {
    fakeBin({ lp: "exit 0", lpstat: "exec /bin/sleep 5" });
    const started = Date.now();
    const r = await checkPrintDest("Slow", 300);
    expect(r.warn).toMatch(/タイムアウト/);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("エラーではなく警告として返す（保存を止める判断は呼び出し側に委ねない）", async () => {
    fakeBin({});
    const r = await checkPrintDest("X");
    // 例外を投げない＝呼び出し側は保存を続行できる
    expect(typeof r.warn).toBe("string");
  });
});
