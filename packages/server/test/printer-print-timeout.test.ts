import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

/**
 * **印刷の子プロセスは時間切れで止める**（`20260921-printer-hold-response` の独立点検の指摘）。
 * 出力が終わるまでホストへ応答しないので、`lp` が返らないと帳票の応答が止まったまま再試行バーも出なかった。
 * `spawn` の `timeout` で止め、止めたら失敗として返す（→ 応答を止めて再試行・取消を待つ）。
 */
const spawned: { cmd: string; opts: { timeout?: number } ; proc: EventEmitter }[] = [];
vi.mock("node:child_process", () => ({
  spawn: (cmd: string, _args: string[], opts: { timeout?: number }) => {
    const proc = new EventEmitter() as EventEmitter & { stdout?: unknown; stderr?: unknown };
    spawned.push({ cmd, opts, proc });
    return proc;
  }
}));

const { handleReport } = await import("../src/printer-output.js");
const { PRINT_TIMEOUT_MS } = await import("../src/print-windows.js");

const report = { id: "spool-1", pages: [{ lines: ["A"] }], raw: new Uint8Array([0xc1]) } as never;
const until = async (cond: () => boolean) => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
};

beforeEach(() => void spawned.splice(0));

describe.skipIf(process.platform === "win32")("lp の時間切れ", () => {
  it("lp を `timeout` 付きで起動する", async () => {
    const p = handleReport(report, { autoPrint: "q1" });
    await until(() => spawned.length > 0);
    expect(spawned[0]!.cmd).toBe("lp");
    expect(spawned[0]!.opts.timeout).toBe(PRINT_TIMEOUT_MS);
    spawned[0]!.proc.emit("close", 0, null);
    expect((await p).printed).toBe(true);
  });

  it("**時間切れで止めたら失敗として返す**（理由に時間切れと書く）", async () => {
    const warn = vi.fn();
    const p = handleReport(report, { autoPrint: "q1" }, warn);
    await until(() => spawned.length > 0);
    spawned[0]!.proc.emit("close", null, "SIGTERM");
    const r = await p;
    expect(r.printed).toBe(false);
    expect(r.printError).toMatch(/120 秒で終わらないので止めました/);
    expect(warn).toHaveBeenCalled();
  });

  it("ホスト変換の印刷データ（raw）も同じ", async () => {
    const p = handleReport(report, { autoPrint: "q1", rawPrint: true });
    await until(() => spawned.length > 0);
    expect(spawned[0]!.opts.timeout).toBe(PRINT_TIMEOUT_MS);
    spawned[0]!.proc.emit("close", null, "SIGTERM");
    expect((await p).printed).toBe(false);
  });
});

describe("Windows の印刷（PowerShell）の時間切れ", () => {
  it("`timeout` 付きで起動し、止めたら失敗として返す", async () => {
    const { printOnWindows } = await import("../src/print-windows.js");
    const p = printOnWindows({ printer: "q1", file: "x.txt" }, () => {});
    await until(() => spawned.length > 0);
    expect(spawned[0]!.opts.timeout).toBe(PRINT_TIMEOUT_MS);
    spawned[0]!.proc.emit("close", null, "SIGTERM");
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/止めました/);
  });
});
