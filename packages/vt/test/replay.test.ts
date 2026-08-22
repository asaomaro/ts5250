import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { VtSession } from "../src/session/vt-session.js";
import { Trace } from "../src/trace/trace.js";
import { ReplayTransport } from "../src/trace/replay.js";

/**
 * **実ホストから採ったバイト列を再生して回帰資産にする。**
 *
 * docker もホストも要らない。実機で一度確かめた並びを、そのまま単体テストに固定できる
 * （5250 / 3270 と同じ方式）。
 *
 * 採り方は `scripts/capture-vt-trace.mjs`。**IBM i はサインオン画面が出た時点で採り終える**
 * ので、記録に資格情報が入る余地が無い。
 */
const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): ReplayTransport =>
  ReplayTransport.fromEntries(Trace.fromJsonl(readFileSync(join(here, "fixtures", name), "utf8")));

function replay(name: string, opts: Record<string, unknown> = {}): VtSession {
  const s = new VtSession({ host: "replay", writeDelayMs: 0, ...opts });
  s.attach(fixture(name));
  return s;
}

const text = (s: VtSession): string[] =>
  s.snapshot().cells.map((r) => r.map((c) => (c.width === 0 ? "" : c.char)).join("").replace(/ +$/u, ""));

describe("Linux（vi の出入り）", () => {
  it("**代替画面から戻ったら主画面が残っている**", () => {
    const s = replay("linux-vi.jsonl");
    const joined = text(s).join("\n");
    expect(s.snapshot().alternate).toBe(false);
    expect(joined).toContain("MAIN");
  });

  it("日本語が全角として並ぶ", () => {
    const s = replay("linux-vi.jsonl");
    const row = s.snapshot().cells.find((r) => r.some((c) => c.char === "あ"));
    expect(row).toBeDefined();
    const i = row!.findIndex((c) => c.char === "あ");
    expect(row![i]!.width).toBe(2);
    expect(row![i + 1]!.width).toBe(0);
    expect(row![i + 2]!.char).toBe("い");
  });

  it("256 色が属性として残る", () => {
    const s = replay("linux-vi.jsonl");
    const colored = s.snapshot().cells
      .flat()
      .find((c) => c.style.fg.kind === "indexed" && c.style.fg.index === 208);
    expect(colored).toBeDefined();
  });

  it("**ホストが ECHO を握っている**（文字モードが成立した記録）", () => {
    expect(replay("linux-vi.jsonl").hostEchoes).toBe(true);
  });
});

describe("IBM i（pub400 のサインオン画面）", () => {
  it("**5250 のパネルが ANSI で降ってきて画面になる**", () => {
    const s = replay("ibmi-signon.jsonl", { terminalTypes: ["VT220"], ccsid: 37 });
    const joined = text(s).join("\n");
    expect(joined).toContain("PUB400");
    expect(joined).toMatch(/user name|User/iu);
    expect(joined).toMatch(/QPADEV/u);
  });

  it("`DO NEW-ENVIRON` で IBM i と判定している", () => {
    expect(replay("ibmi-signon.jsonl").isIbmI).toBe(true);
  });

  it("桁が保たれる（右側の欄が 47 桁目から始まる）", () => {
    const s = replay("ibmi-signon.jsonl");
    const row = text(s).find((l) => l.includes("Server name"));
    expect(row).toBeDefined();
    expect(row!.indexOf("Server name")).toBeGreaterThan(40);
  });
});

describe("再生と実接続で挙動が分かれない", () => {
  it("**同じバイト列を 1 バイトずつ食わせても同じ画面になる**（分割到着への耐性）", () => {
    const entries = Trace.fromJsonl(
      readFileSync(join(here, "fixtures", "ibmi-signon.jsonl"), "utf8")
    );
    const whole = new VtSession({ host: "r", writeDelayMs: 0 });
    whole.attach(ReplayTransport.fromEntries(entries));

    const split = new VtSession({ host: "r", writeDelayMs: 0 });
    const oneByOne = entries
      .filter((e) => e.dir === "in")
      .flatMap((e) => {
        const bytes = e.hex.match(/../gu) ?? [];
        return bytes.map((h) => ({ dir: "in" as const, seq: 0, hex: h }));
      });
    split.attach(ReplayTransport.fromEntries(oneByOne));

    expect(text(split)).toEqual(text(whole));
  });
});
