import { describe, it, expect } from "vitest";
import { appendSqlLog, SQL_LOG_MAX, type SqlLogEntry } from "../src/sqlLog.js";

/**
 * SQL 実行ログの記録。
 *
 * **サーバーへ送らない**設計なので、ここで固定するのは溜め込みの上限と
 * 追記の順序だけ。表示は `SqlLogPanel.vue`、経路は `sql-pane.test.ts` で見る。
 */
const base = { ts: 1, kind: "run" as const, sql: "SELECT 1", status: "ok" as const, ms: 5 };

describe("追記", () => {
  it("後ろに足し、id が増える", () => {
    let e: SqlLogEntry[] = [];
    e = appendSqlLog(e, { ...base, sql: "A" });
    e = appendSqlLog(e, { ...base, sql: "B" });
    expect(e.map((x) => x.sql)).toEqual(["A", "B"]);
    expect(e[1]!.id).toBeGreaterThan(e[0]!.id);
  });

  it("元の配列を書き換えない（ref を差し替える前提のため）", () => {
    const before: SqlLogEntry[] = [];
    const after = appendSqlLog(before, base);
    expect(before).toHaveLength(0);
    expect(after).toHaveLength(1);
  });

  it("**上限を超えたら古いものから落とす**（際限なく溜めない）", () => {
    let e: SqlLogEntry[] = [];
    for (let i = 0; i < SQL_LOG_MAX + 10; i++) e = appendSqlLog(e, { ...base, sql: `S${i}` });
    expect(e).toHaveLength(SQL_LOG_MAX);
    expect(e[0]!.sql).toBe("S10"); // 先頭 10 件が落ちている
    expect(e[e.length - 1]!.sql).toBe(`S${SQL_LOG_MAX + 9}`);
  });
});
