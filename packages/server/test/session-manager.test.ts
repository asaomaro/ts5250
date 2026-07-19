import { describe, it, expect } from "vitest";
import { SessionManager } from "../src/session-manager.js";
import { ReplayTransport, parseTraceJsonl, As400Error } from "@as400web/core";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// core の実機 fixture を借用（サインオン画面まで到達すれば十分）
const signonFixture = () =>
  parseTraceJsonl(
    readFileSync(join(here, "..", "..", "core", "test", "fixtures", "pub400-signon.jsonl"), "utf8")
  );

function openReplay(mgr: SessionManager, readOnly = false) {
  return mgr.open({ transport: new ReplayTransport(signonFixture()), readOnly });
}

describe("SessionManager", () => {
  it("セッションを開いて get/list できる", async () => {
    const mgr = new SessionManager();
    const entry = await openReplay(mgr);
    expect(mgr.size).toBe(1);
    expect(mgr.get(entry.id).id).toBe(entry.id);
    expect(mgr.list()).toHaveLength(1);
    mgr.closeAll();
  });

  it("上限を超えると CONNECT_FAILED", async () => {
    const mgr = new SessionManager({ maxSessions: 1 });
    await openReplay(mgr);
    await expect(openReplay(mgr)).rejects.toSatisfy(
      (e: unknown) => e instanceof As400Error && e.code === "CONNECT_FAILED"
    );
    mgr.closeAll();
  });

  it("不明な sessionId は SESSION_NOT_FOUND", () => {
    const mgr = new SessionManager();
    expect(() => mgr.get("nope")).toThrow(
      expect.objectContaining({ code: "SESSION_NOT_FOUND" })
    );
  });

  it("readOnly セッションは assertWritable で拒否、通常は通す", async () => {
    const mgr = new SessionManager();
    const ro = await openReplay(mgr, true);
    const rw = await openReplay(mgr, false);
    expect(() => mgr.assertWritable(ro.id)).toThrow(
      expect.objectContaining({ code: "READ_ONLY_SESSION" })
    );
    expect(mgr.assertWritable(rw.id).id).toBe(rw.id);
    mgr.closeAll();
  });

  it("readOnly は PageUp/PageDown のみ AID を許可する", async () => {
    const mgr = new SessionManager();
    const ro = await openReplay(mgr, true);
    expect(mgr.assertKeyAllowed(ro.id, "PageUp").id).toBe(ro.id);
    expect(mgr.assertKeyAllowed(ro.id, "PageDown").id).toBe(ro.id);
    expect(() => mgr.assertKeyAllowed(ro.id, "Enter")).toThrow(
      expect.objectContaining({ code: "READ_ONLY_SESSION" })
    );
    expect(() => mgr.assertKeyAllowed(ro.id, "F3")).toThrow(
      expect.objectContaining({ code: "READ_ONLY_SESSION" })
    );
    mgr.closeAll();
  });

  it("close でセッションが除去される", async () => {
    const mgr = new SessionManager();
    const entry = await openReplay(mgr);
    await mgr.close(entry.id);
    expect(mgr.size).toBe(0);
    expect(() => mgr.get(entry.id)).toThrow(
      expect.objectContaining({ code: "SESSION_NOT_FOUND" })
    );
  });

  it("アイドルタイムアウトで掃除される", async () => {
    let t = 1000;
    const mgr = new SessionManager({ idleTimeoutMs: 100, now: () => t });
    const entry = await openReplay(mgr);
    expect(mgr.size).toBe(1);
    t += 200; // アイドル超過
    // sweepIdle は private のため、get の lastActivity 更新前に startIdleSweep 経由で呼ぶ代わりに
    // 直接時間を進めて close 判定を検証（sweep を明示起動）
    (mgr as unknown as { sweepIdle: () => void }).sweepIdle();
    expect(mgr.size).toBe(0);
    void entry;
  });
});
