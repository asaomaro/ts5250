import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { withAudit, setAuditSink, type AuditEvent } from "../src/audit.js";

let events: AuditEvent[];

beforeEach(() => {
  events = [];
  setAuditSink((e) => events.push(e));
});
afterEach(() => {
  setAuditSink(() => {}); // 後続テストへ漏らさない
});

describe("withAudit", () => {
  it("成功時に op/result/duration を記録する（値は含まない）", async () => {
    let t = 0;
    const now = () => (t += 5);
    const r = await withAudit(
      { op: "send_key", sessionId: "abc", key: "Enter", fields: [{ row: 6, col: 10 }] },
      async () => "result",
      now
    );
    expect(r).toBe("result");
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e.op).toBe("send_key");
    expect(e.result).toBe("ok");
    expect(e.sessionId).toBe("abc");
    expect(e.fields).toEqual([{ row: 6, col: 10 }]);
    expect(e.durationMs).toBe(5);
    // イベントには値フィールドが存在しない（座標のみ）
    expect(JSON.stringify(e)).not.toContain("value");
  });

  it("fn が isError 応答を返した場合も error として記録する（例外を投げなくても）", async () => {
    const errResult = {
      isError: true,
      content: [{ type: "text", text: "SESSION_NOT_FOUND: ..." }],
      structuredContent: { error: { code: "SESSION_NOT_FOUND", message: "..." } }
    };
    const r = await withAudit({ op: "get_screen", sessionId: "x" }, async () => errResult);
    expect(r).toBe(errResult); // 応答はそのまま返す
    expect(events[0]).toMatchObject({ op: "get_screen", result: "error", code: "SESSION_NOT_FOUND" });
  });

  it("成功応答（isError なし）は ok のまま", async () => {
    await withAudit({ op: "get_screen", sessionId: "x" }, async () => ({ content: [], structuredContent: {} }));
    expect(events[0]).toMatchObject({ result: "ok" });
  });

  it("例外時は error と code を記録して再送出する", async () => {
    const err = Object.assign(new Error("boom"), { code: "KEYBOARD_LOCKED" });
    await expect(
      withAudit({ op: "set_fields", sessionId: "x" }, async () => {
        throw err;
      })
    ).rejects.toBe(err);
    expect(events[0]).toMatchObject({ op: "set_fields", result: "error", code: "KEYBOARD_LOCKED" });
  });
});
