import { describe, it, expect, vi } from "vitest";
import { listPlansFromCache, planFromCache } from "../src/db/plan-cache.js";
import { As400Error } from "@ts5250/base";
import type { DbConnection } from "../src/db/db-connection.js";

/**
 * プランキャッシュ一覧の**権限判定**を固定する。
 *
 * `20260802-sql-visual-explain` の research F15: PUB400（特殊権限なしの `MARO`）で
 * `CALL QSYS2.DUMP_PLAN_CACHE_TOPN(...)` は **`SQLCODE -443 / SQLSTATE 38501`** で失敗した。
 * SR-OSAKA（全特権）では同じ呼び出しが成功する。
 *
 * **この組み合わせだけ**を「権限不足」と言う。他の SQLCODE を権限と決めつけると、
 * 利用者が無駄に権限を探しに行くことになる。
 */

const CP_SQLCA = 0x3807;
const CP_SUPER_EXTENDED_FORMAT = 0x3812;
const REQ_PREPARE_AND_DESCRIBE = 0x1803;
/**
 * 1 往復の道（`executeImmediate`）。**マーカーの無い非クエリ文はこちらを通る**
 * ので、文を記録する偽の接続は両方を拾わないと取りこぼす（2026-08-22）。
 */
const REQ_EXECUTE_IMMEDIATE = 0x1806;
const isStatementRequest = (reqId: number): boolean =>
  reqId === REQ_PREPARE_AND_DESCRIBE || reqId === REQ_EXECUTE_IMMEDIATE;
const CP_SQL_TEXT = 0x3807;

function sqlca(sqlCode: number, sqlState: string): Uint8Array {
  const out = new Uint8Array(136);
  new DataView(out.buffer).setInt32(12, sqlCode);
  for (let i = 0; i < 5; i++) {
    const ch = sqlState.charCodeAt(i);
    // EBCDIC: 数字は 0xF0-0xF9、英大文字 A-I は 0xC1-0xC9
    out[131 + i] =
      ch >= 0x30 && ch <= 0x39 ? 0xf0 + (ch - 0x30) : ch >= 0x41 && ch <= 0x49 ? 0xc1 + (ch - 0x41) : 0x40;
  }
  return out;
}

function emptyFormat(): Uint8Array {
  const out = new Uint8Array(16);
  new DataView(out.buffer).setUint32(4, 0);
  return out;
}

interface Frame {
  reqId: number;
  params: readonly { cp: number; value: Uint8Array }[];
}

function sentSql(frame: Frame): string | undefined {
  const p = frame.params.find((x) => x.cp === CP_SQL_TEXT);
  if (!p) return undefined;
  const v = new DataView(p.value.buffer, p.value.byteOffset, p.value.byteLength);
  const len = v.getUint16(2);
  let s = "";
  for (let i = 0; i < len / 2; i++) s += String.fromCharCode(v.getUint16(4 + i * 2));
  return s;
}

/** `DUMP_PLAN_CACHE_TOPN` だけ指定の SQLCODE で失敗させる偽の接続 */
function fakeConn(fail?: { sqlCode: number; sqlState: string }) {
  const statements: string[] = [];
  const request = vi.fn(async (frame: Frame) => {
    if (isStatementRequest(frame.reqId)) {
      const sql = sentSql(frame);
      if (sql !== undefined) statements.push(sql);
      if (fail && sql?.includes("DUMP_PLAN_CACHE_TOPN")) {
        return {
          params: [{ cp: CP_SQLCA, value: sqlca(fail.sqlCode, fail.sqlState) }],
          dbTemplate: { rcClass: 0, rcClassReturnCode: 0 }
        };
      }
    }
    return {
      params: [
        { cp: CP_SQLCA, value: sqlca(0, "00000") },
        { cp: CP_SUPER_EXTENDED_FORMAT, value: emptyFormat() }
      ],
      dbTemplate: { rcClass: 0, rcClassReturnCode: 0 }
    };
  });
  const conn = { request, acquire: () => () => undefined } as unknown as DbConnection;
  return { conn, statements };
}

describe("プランキャッシュ一覧の権限判定", () => {
  it("**-443 / 38501 は権限不足**として理由付きで無効化する（例外にしない）", async () => {
    const { conn } = fakeConn({ sqlCode: -443, sqlState: "38501" });
    const r = await listPlansFromCache(conn, 20);

    expect(r.available).toBe(false);
    expect(r.items).toEqual([]);
    // **何が要るかまで書く**
    expect(r.reason).toContain("*JOBCTL");
  });

  it("**他の SQLCODE を権限と決めつけない**（原因をそのまま出す）", async () => {
    const { conn } = fakeConn({ sqlCode: -204, sqlState: "42704" });
    const r = await listPlansFromCache(conn, 20);

    expect(r.available).toBe(false);
    expect(r.reason).not.toContain("*JOBCTL");
    expect(r.reason).toContain("-204");
    expect(r.reason).toContain("42704");
  });

  it("同じ -443 でも SQLSTATE が違えば権限と言わない", async () => {
    // 42815 は引数の型・値の誤り（research で PROCESS_DETAILED_MONITOR が返した）
    const { conn } = fakeConn({ sqlCode: -443, sqlState: "42815" });
    const r = await listPlansFromCache(conn, 20);

    expect(r.available).toBe(false);
    expect(r.reason).not.toContain("*JOBCTL");
  });

  it("CATEGORY は実測で有効だった RUNTIME を使い、TOPN を渡す", async () => {
    const { conn, statements } = fakeConn();
    await listPlansFromCache(conn, 7);

    const call = statements.find((s) => s.includes("DUMP_PLAN_CACHE_TOPN"));
    expect(call).toContain("'RUNTIME'");
    expect(call).toContain(", 7, ");
  });

  it("成功して記録が空なら、参照できたうえで 0 件（権限の話にしない）", async () => {
    const { conn } = fakeConn();
    const r = await listPlansFromCache(conn, 20);

    expect(r.available).toBe(true);
    expect(r.items).toEqual([]);
  });

  it("ダンプ表は読み終わったら落とす", async () => {
    const { conn, statements } = fakeConn();
    await listPlansFromCache(conn, 20);
    expect(statements.some((s) => s.includes("DROP TABLE QTEMP.VEP"))).toBe(true);
  });

  it("権限不足で落ちたときは表を作っていないので DROP も要らない", async () => {
    const { conn, statements } = fakeConn({ sqlCode: -443, sqlState: "38501" });
    await listPlansFromCache(conn, 20);
    expect(statements.some((s) => s.includes("DROP TABLE"))).toBe(false);
  });
});

describe("一覧から計画を開く", () => {
  it("id がダンプに無ければ**黙って空を返さず**理由を出す（キャッシュは変わりうる）", async () => {
    const { conn } = fakeConn();
    await expect(planFromCache(conn, 20, "999", "2026-08-02T00:00:00Z")).rejects.toThrow(As400Error);
    await expect(planFromCache(conn, 20, "999", "2026-08-02T00:00:00Z")).rejects.toThrow(
      /プランキャッシュの内容が変わった/u
    );
  });

  it("2 段目の DUMP_PLAN_CACHE は呼ばない（同じ表を QQUCNT で絞るだけ）", async () => {
    const { conn, statements } = fakeConn();
    await planFromCache(conn, 20, "1", "2026-08-02T00:00:00Z").catch(() => undefined);
    expect(statements.some((s) => /DUMP_PLAN_CACHE\s*\(/u.test(s))).toBe(false);
  });
});
