/**
 * セッションの寿命（アイドルタイムアウト・永続）。
 *
 * 既定を**永続**にし、セッション設定で「分」か「切らない」を選べるようにした変更の回帰資産。
 * 判定は**エントリごと**で、マネージャ共通の cutoff で全部を切ってはいけない
 * （`20260729-session-lifetime-timeout` spec 方針1・2）。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ReplayTransport, parseTraceJsonl, type Transport } from "@ts5250/tn5250";
import {
  ORPHAN_IDLE_TIMEOUT_MS,
  SessionManager,
  orphanSafeIdleTimeoutMs,
  type IdleLimit
} from "../src/session-manager.js";
import { idleTimeoutToMs, personalSessionSchema, type IdleTimeout } from "../src/config-types.js";
import { PersonalConfigStore } from "../src/config-store.js";
import { parseIdleTimeout } from "../src/main.js";

const here = dirname(fileURLToPath(import.meta.url));
const signonFixture = () =>
  parseTraceJsonl(
    readFileSync(join(here, "..", "..", "tn5250", "test", "fixtures", "pub400-signon.jsonl"), "utf8")
  );

/** private な sweepIdle を叩く（既存テストと同じ手） */
const sweep = (mgr: SessionManager): void =>
  (mgr as unknown as { sweepIdle: () => void }).sweepIdle();

function openReplay(mgr: SessionManager, idleTimeoutMs?: IdleLimit) {
  return mgr.open({
    transport: new ReplayTransport(signonFixture()),
    ...(idleTimeoutMs !== undefined ? { idleTimeoutMs } : {})
  });
}

/** startup だけ返す最小のプリンター transport（`printer-manager.test.ts` の縮小版） */
class PrinterTransport implements Transport {
  private dataFn: ((d: Uint8Array) => void) | undefined;
  send(): void {}
  close(): void {}
  onData(fn: (d: Uint8Array) => void): void {
    this.dataFn = fn;
  }
  onClose(): void {}
  onError(): void {}
  start(): void {
    const body = [0x12, 0xa0, 0x90, 0x00, 0x04, 0x00, 0x00, 0x00, 0, 0, 0, 0, 0, 0xc9, 0xf9, 0xf0, 0xf2];
    const ll = body.length + 2;
    this.dataFn?.(Uint8Array.from([(ll >> 8) & 0xff, ll & 0xff, ...body, 0xff, 0xef]));
  }
}

describe("アイドルタイムアウト: 既定は永続", () => {
  it("引数なしのマネージャは、いくら時間が経っても掃除しない", async () => {
    let t = 1000;
    const mgr = new SessionManager({ now: () => t });
    await openReplay(mgr);
    t += 365 * 24 * 60 * 60_000; // 1 年
    sweep(mgr);
    expect(mgr.size).toBe(1);
    mgr.closeAll();
  });

  it("マネージャ既定に有限値を渡せば切れる（--idle-timeout の経路）", async () => {
    let t = 1000;
    const mgr = new SessionManager({ idleTimeoutMs: 100, now: () => t });
    await openReplay(mgr);
    t += 200;
    sweep(mgr);
    expect(mgr.size).toBe(0);
  });
});

describe("アイドルタイムアウト: 判定はエントリごと", () => {
  it("マネージャが有限でも、エントリが never なら切らない", async () => {
    let t = 1000;
    const mgr = new SessionManager({ idleTimeoutMs: 100, now: () => t });
    await openReplay(mgr, "never");
    t += 10_000;
    sweep(mgr);
    expect(mgr.size).toBe(1);
    mgr.closeAll();
  });

  it("マネージャが永続でも、エントリが有限なら切る", async () => {
    let t = 1000;
    const mgr = new SessionManager({ now: () => t });
    await openReplay(mgr, 100);
    t += 200;
    sweep(mgr);
    expect(mgr.size).toBe(0);
  });

  it("同じマネージャの中で永続と有限が混在しても、有限の方だけが切れる", async () => {
    let t = 1000;
    const mgr = new SessionManager({ now: () => t });
    const keep = await openReplay(mgr, "never");
    const drop = await openReplay(mgr, 100);
    t += 200;
    sweep(mgr);
    expect(mgr.size).toBe(1);
    expect(mgr.get(keep.id).id).toBe(keep.id);
    expect(() => mgr.get(drop.id)).toThrow(expect.objectContaining({ code: "SESSION_NOT_FOUND" }));
    mgr.closeAll();
  });

  it("プリンターセッションも同じ判定を受ける（表示だけ効くのは転記漏れ）", async () => {
    let t = 1000;
    const mgr = new SessionManager({ now: () => t });
    await mgr.openPrinter({ transport: new PrinterTransport(), idleTimeoutMs: 100 });
    const keep = await mgr.openPrinter({ transport: new PrinterTransport(), idleTimeoutMs: "never" });
    expect(mgr.size).toBe(2);
    t += 200;
    sweep(mgr);
    expect(mgr.size).toBe(1);
    expect(mgr.getPrinter(keep.id).id).toBe(keep.id);
    mgr.closeAll();
  });
});

describe("touch(): 在席の合図で lastActivity が進む", () => {
  it("有限値でも touch を挟めば切られない", async () => {
    let t = 1000;
    const mgr = new SessionManager({ now: () => t });
    const entry = await openReplay(mgr, 100);
    t += 80;
    mgr.touch(entry.id); // 打鍵中（AID は押していない）
    t += 80; // 合計 160ms 経過だが、最後の活動からは 80ms
    sweep(mgr);
    expect(mgr.size).toBe(1);
    mgr.closeAll();
  });

  it("プリンターセッションにも効く", async () => {
    let t = 1000;
    const mgr = new SessionManager({ now: () => t });
    const entry = await mgr.openPrinter({ transport: new PrinterTransport(), idleTimeoutMs: 100 });
    t += 80;
    mgr.touch(entry.id);
    t += 80;
    sweep(mgr);
    expect(mgr.size).toBe(1);
    mgr.closeAll();
  });

  it("未知の id では投げない（閉じたセッションへの遅延メッセージ）", () => {
    const mgr = new SessionManager();
    expect(() => mgr.touch("nope")).not.toThrow();
  });
});

describe("orphanSafeIdleTimeoutMs(): MCP に永続を通さない", () => {
  it("有限値はそのまま尊重する", () => {
    expect(orphanSafeIdleTimeoutMs(5 * 60_000)).toBe(5 * 60_000);
  });

  it('"never" は安全網の値に落とす（切断が通知されないため）', () => {
    expect(orphanSafeIdleTimeoutMs("never")).toBe(ORPHAN_IDLE_TIMEOUT_MS);
  });

  it("未設定も安全網の値になる（従来の既定と同じ 30 分）", () => {
    expect(orphanSafeIdleTimeoutMs(undefined)).toBe(30 * 60_000);
  });
});

describe("設定値の表現", () => {
  it("分 → ms に変換する", () => {
    expect(idleTimeoutToMs(30)).toBe(30 * 60_000);
  });

  it('"never" はそのまま運ぶ', () => {
    expect(idleTimeoutToMs("never")).toBe("never");
  });

  it("未設定は undefined のまま（＝マネージャ既定に従う。永続と混ぜない）", () => {
    expect(idleTimeoutToMs(undefined)).toBeUndefined();
  });

  it("スキーマは 1〜1440 分と never だけを受ける（0 も null も拒否）", () => {
    const base = { id: "s1", name: "n", system: "sys", sessionType: "display" as const };
    expect(personalSessionSchema.safeParse({ ...base, idleTimeout: 30 }).success).toBe(true);
    expect(personalSessionSchema.safeParse({ ...base, idleTimeout: "never" }).success).toBe(true);
    expect(personalSessionSchema.safeParse({ ...base, idleTimeout: 1440 }).success).toBe(true);
    expect(personalSessionSchema.safeParse({ ...base, idleTimeout: 0 }).success).toBe(false);
    expect(personalSessionSchema.safeParse({ ...base, idleTimeout: null }).success).toBe(false);
    expect(personalSessionSchema.safeParse({ ...base, idleTimeout: 1441 }).success).toBe(false);
    expect(personalSessionSchema.safeParse({ ...base, idleTimeout: 1.5 }).success).toBe(false);
    // 未設定は通る（＝サーバー既定に従う）
    expect(personalSessionSchema.safeParse(base).success).toBe(true);
  });
});

describe("API 応答への露出", () => {
  /** `publicSession()` は**列挙式**なので、足したキーを転記し忘れると UI から見えない */
  const store = (idleTimeout?: IdleTimeout) =>
    new PersonalConfigStore({
      systems: [{ id: "s", name: "s", host: "h" }],
      sessions: [
        {
          id: "d",
          name: "d",
          system: "s",
          sessionType: "display",
          ...(idleTimeout !== undefined ? { idleTimeout } : {})
        }
      ]
    });

  it("設定した分がそのまま返る", () => {
    expect(store(30).listSessions(undefined)[0]?.idleTimeout).toBe(30);
  });

  it('"never" もそのまま返る', () => {
    expect(store("never").listSessions(undefined)[0]?.idleTimeout).toBe("never");
  });

  it("未設定ならキーごと付かない", () => {
    expect("idleTimeout" in (store().listSessions(undefined)[0] ?? {})).toBe(false);
  });
});

describe("--idle-timeout の解釈", () => {
  it("分を ms にする", () => {
    expect(parseIdleTimeout("30")).toBe(30 * 60_000);
  });

  it("never は永続", () => {
    expect(parseIdleTimeout("never")).toBe("never");
  });

  it("0・範囲外・非数値・未指定は起動時に弾く", () => {
    expect(() => parseIdleTimeout("0")).toThrow();
    expect(() => parseIdleTimeout("1441")).toThrow();
    expect(() => parseIdleTimeout("abc")).toThrow();
    expect(() => parseIdleTimeout(undefined)).toThrow();
  });
});
