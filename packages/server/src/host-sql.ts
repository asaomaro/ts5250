/**
 * SQL 実行の API（ホストサーバーの database サーバー経由）。
 *
 * **ブラウザから任意の SQL 文字列を受け取る。** 一覧 API（`host-lists.ts`）が任意の CL を
 * 拒んでいるのと方針が違うので、根拠を明記する（spec D1）:
 *
 * この API が安全なのは「実行するのが SELECT だけ」だからではなく、
 * **`query` の実装が結果セットを持たない文を実行できない**ためである。
 * 手順が `prepare + describe` → `open + describe` → `fetch` で、結果セットの無い文は
 * describe の段階で落ちる。実機（PUB400）で次を確認した:
 *
 *   - `CREATE TABLE` → エラーになり、**表は作られない**（後から DLTOBJ が not found）
 *   - `CALL QSYS2.QCMDEXC('CRTDTAARA …')` → エラーになり、**データ域は作られない**
 *     （別経路のオブジェクト一覧で不在を確認）
 *   - `SELECT …; DROP TABLE …`（複文）→ SQLCODE -104 で拒否
 *
 * ⚠ **この API の安全性は `query` の上記の性質に依存している。**
 * 将来 `query` に更新系を通す改造（`executeImmediate` の追加等）を入れると、
 * ブラウザから任意の更新が通るようになる。そのときは必ずこの方針を再検討すること。
 *
 * なお読み取り範囲は IBM i の権限が決める（`host-lists.ts` と同じ原則。アプリ側で制限しない）。
 */
import { Hono } from "hono";
import { z } from "zod";
import { query, SqlError, As400Error, type DbConnection } from "@as400web/core";
import type { AuthVars } from "./auth.js";
import type { ConfigResolver } from "./config-resolver.js";
import { openDb } from "./host-connect.js";
import { resolveSource, sourceSchema, statusOf } from "./host-api.js";

/** 応答に載せる行数の上限（サーバー側で強制する。UI の出し分けに依存しない） */
const MAX_ROWS = 1000;
const DEFAULT_ROWS = 200;
/** LOB 1 セルあたりの上限。これ以上は受け付けない */
const MAX_LOB_BYTES = 1024 * 1024;

const sqlRequestSchema = z
  .object({
    source: sourceSchema,
    sql: z.string().min(1),
    maxRows: z.number().int().positive().max(MAX_ROWS).optional(),
    /** LOB の中身も取得する。**既定では取りに行かない**（大きな LOB でメモリを掴むため） */
    lobMaxBytes: z.number().int().positive().max(MAX_LOB_BYTES).optional()
  })
  .strict();

export interface HostSqlDeps {
  /** 接続設定の唯一の解決点 */
  resolver: ConfigResolver;
}

export function registerHostSqlRoutes(app: Hono<{ Variables: AuthVars }>, deps: HostSqlDeps): void {
  app.post("/api/host/sql", async (c) => {
    const parsed = sqlRequestSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message ?? "invalid request" }, 400);
    }
    const { source, sql, maxRows, lobMaxBytes } = parsed.data;
    const user = c.get("user");

    let conn: DbConnection | undefined;
    try {
      conn = await openDb(resolveSource(deps.resolver, source, user));
      const max = maxRows ?? DEFAULT_ROWS;
      const result = await query(conn, sql, lobMaxBytes ? { lob: { maxBytes: lobMaxBytes } } : {});
      const rows = result.rows.slice(0, max);
      return c.json({
        columns: result.columns.map((col) => ({
          name: col.name,
          typeName: col.typeName,
          length: col.length,
          scale: col.scale,
          precision: col.precision,
          ccsid: col.ccsid,
          nullable: col.nullable
        })),
        // bigint は JSON にできないため文字列にする（精度を落とさない）
        rows: rows.map((r) =>
          Object.fromEntries(
            Object.entries(r).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v])
          )
        ),
        rowCount: rows.length,
        // **切り詰めは応答側だけ**。`query` は結果セットを全件取得してから返すため、
        // これはホストからの取得量を減らさない。取得量は SQL 側（FETCH FIRST）の責任で、
        // UI もそう案内している。根本解決は backlog（stream の早期打ち切りが未検証）。
        truncated: result.rows.length > rows.length
      });
    } catch (e) {
      const err = e as As400Error;
      // SQLCODE / SQLSTATE を落とさない——これが無いと文法誤りと権限不足を区別できない
      const detail =
        e instanceof SqlError ? { sqlCode: e.sqlCode, sqlState: e.sqlState } : {};
      return c.json(
        { error: err.message, code: err.code ?? "UNKNOWN", ...detail },
        statusOf(err)
      );
    } finally {
      conn?.close();
    }
  });
}
