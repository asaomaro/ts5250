import { describe, it, expect } from "vitest";
import {
  runPcCommand,
  isAllowed,
  invalidAllowPattern,
  pcCommandHostname
} from "../src/pc-command.js";

/**
 * PC コマンド（STRPCCMD）の実行。**既定は無効**で、明示的に有効化したときだけ動く。
 * ホストが送ってきた文字列をそのまま OS のシェルへ渡す機能なので、
 * 「有効化していないのに動く」経路が無いことをここで固める。
 */
describe("runPcCommand", () => {
  it("設定が無ければ実行しない（既定は無効）", async () => {
    expect(await runPcCommand({ command: "echo x", wait: true }, undefined)).toEqual({
      status: "disabled"
    });
  });

  it("enabled を立てていなければ実行しない", async () => {
    expect(await runPcCommand({ command: "echo x", wait: true }, { timeoutMs: 5000 })).toEqual({
      status: "disabled"
    });
  });

  it("有効なら実行して終了コードを返す（PAUSE(*YES) 相当）", async () => {
    const r = await runPcCommand({ command: "exit 0", wait: true }, { enabled: true });
    expect(r.status).toBe("ran");
    if (r.status === "ran") expect(r.exitCode).toBe(0);
  });

  it("終了コードは握りつぶさない", async () => {
    const r = await runPcCommand({ command: "exit 3", wait: true }, { enabled: true });
    expect(r.status).toBe("ran");
    if (r.status === "ran") expect(r.exitCode).toBe(3);
  });

  it("PAUSE(*NO) は完了を待たずに started で返る", async () => {
    const r = await runPcCommand({ command: "sleep 5", wait: false }, { enabled: true });
    expect(r).toEqual({ status: "started" });
  });

  it("待つ指定で上限を超えたら打ち切って失敗として返す（ホストは待たせない）", async () => {
    const r = await runPcCommand({ command: "sleep 5", wait: true }, { enabled: true, timeoutMs: 150 });
    expect(r.status).toBe("failed");
    if (r.status === "failed") expect(r.error).toMatch(/timed out/);
  });

  it("空のコマンドは失敗として扱う", async () => {
    const r = await runPcCommand({ command: "   ", wait: true }, { enabled: true });
    expect(r.status).toBe("failed");
  });

  it("許可リストに合わなければ実行しない", async () => {
    const cfg = { enabled: true, allow: ["echo .*"] };
    expect(await runPcCommand({ command: "rm -rf /tmp/x", wait: true }, cfg)).toEqual({
      status: "denied"
    });
    const ok = await runPcCommand({ command: "echo hi", wait: true }, cfg);
    expect(ok.status).toBe("ran");
  });

  it("作業ディレクトリーを指定できる", async () => {
    const r = await runPcCommand({ command: "test -d .", wait: true }, { enabled: true, cwd: "/tmp" });
    expect(r.status).toBe("ran");
    if (r.status === "ran") expect(r.exitCode).toBe(0);
  });
});

describe("isAllowed", () => {
  it("パターン省略は制限なし", () => {
    expect(isAllowed("anything", undefined)).toBe(true);
    expect(isAllowed("anything", [])).toBe(true);
  });

  it("**全体一致**で判定する（前方一致だと後置きが素通りする）", () => {
    expect(isAllowed("notepad", ["notepad"])).toBe(true);
    expect(isAllowed("notepad; rm -rf /", ["notepad"])).toBe(false);
    expect(isAllowed("xnotepad", ["notepad"])).toBe(false);
  });

  it("複数パターンはいずれかに合えばよい", () => {
    expect(isAllowed("start https://example.com", ["notepad", "start https?://.*"])).toBe(true);
  });

  it("壊れた正規表現は「一致しない」に倒す（緩む方向へ倒さない）", () => {
    expect(isAllowed("anything", ["("])).toBe(false);
  });
});

describe("invalidAllowPattern", () => {
  it("壊れたパターンを見つけて返す（保存前に弾くため）", () => {
    expect(invalidAllowPattern(["ok.*", "["])).toBe("[");
    expect(invalidAllowPattern(["ok.*", "also ok"])).toBeUndefined();
  });
});

describe("pcCommandHostname", () => {
  it("実行先の機械名を返す（UI が「このPC / サーバー」を言い分けるのに使う）", () => {
    expect(pcCommandHostname()).toBeTruthy();
  });
});
