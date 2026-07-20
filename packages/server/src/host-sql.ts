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
 * ---
 *
 * ⚠ **上の「読み取り専用」はこのルート（`/api/host/sql`）についての話であって、
 * ホスト API 全体の不変条件ではない。**
 *
 * 2026-07-20 に `/api/host/upload`（`host-upload.ts`）を追加し、**DDM で物理ファイルに
 * 追記できるようにした**。上の警告が言う「再検討」をそこで行い、次の結論を採っている:
 *
 *   - 書ける範囲は **IBM i 側のオブジェクト権限が決める**。アプリ側で追加の制限を掛けると、
 *     ホストで許された操作を UI が勝手に禁じることになり、既存の設計思想と食い違う。
 *   - よって認可は他のホスト API と同じ「接続を持つユーザーなら誰でも」を踏襲する。
 *
 * この節を消さずに残しているのは、**「なぜ SQL 経路が読み取り専用だったか」の説明が
 * 依然として有効**だからである（消すと次の変更で同じ検討をやり直すことになる）。
 *
 * なお読み取り範囲は IBM i の権限が決める（`host-lists.ts` と同じ原則。アプリ側で制限しない）。
 */
import { Hono } from "hono";
import { z } from "zod";
import { openQuery, query, SqlError, As400Error, type DbConnection } from "@as400web/core";
import type { AuthVars } from "./auth.js";
import type { ConfigResolver } from "./config-resolver.js";
import { openDb, hostAuthFrom } from "./host-connect.js";
import { resolveSource, sourceSchema, statusOf } from "./host-api.js";
import type { ResultSetStore } from "./result-set-store.js";
import { poolKey, type DbPool } from "./db-pool.js";
import { childLog } from "@as400web/core";

const log = childLog({ component: "host-sql" });

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
    lobMaxBytes: z.number().int().positive().max(MAX_LOB_BYTES).optional(),
    /** 1 度に取得する件数。指定すると結果セットを保持し、続きを /next で取れる */
    pageSize: z.number().int().positive().max(MAX_ROWS).optional()
  })
  .strict();

export interface HostSqlDeps {
  /** 接続設定の唯一の解決点 */
  resolver: ConfigResolver;
  /** 画面のページング用。**ここだけが接続を掴み続ける** */
  resultSets: ResultSetStore;
  /** 画面の SQL 用の接続の使い回し（MCP の単発完結は変えない） */
  pool: DbPool;
}

const warmSchema = z.object({ source: sourceSchema }).strict();

const nextSchema = z
  .object({ pageSize: z.number().int().positive().max(MAX_ROWS).optional() })
  .strict();

/** 列メタデータを応答の形に落とす */
function toColumns(columns: readonly { name: string; typeName: string; length: number; scale: number; precision: number; ccsid: number; nullable: boolean }[]) {
  return columns.map((col) => ({
    name: col.name,
    typeName: col.typeName,
    length: col.length,
    scale: col.scale,
    precision: col.precision,
    ccsid: col.ccsid,
    nullable: col.nullable
  }));
}

/**
 * 接続の素性を画面へ返す。
 *
 * **ジョブ名を出すのは障害切り分けのため**——実機側で WRKACTJOB と突き合わせられる。
 * `reused` は「使い回した接続か」で、`ms` はその取得にかかった時間
 * （使い回しならほぼ 0、張り直しなら 4〜6 秒）。
 *
 * ジョブ名に秘密は含まれない（`832122/QUSER/QZDASOINIT` の形）。
 */
function connectionInfo(conn: DbConnection, reused: boolean, ms: number) {
  return {
    ...(conn.jobName !== undefined ? { job: conn.jobName } : {}),
    host: conn.host,
    port: conn.port,
    reused,
    ms
  };
}

/** bigint は JSON にできないため文字列にする（精度を落とさない） */
function toJsonRows(rows: readonly Record<string, unknown>[]) {
  return rows.map((r) =>
    Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v]))
  );
}

export function registerHostSqlRoutes(app: Hono<{ Variables: AuthVars }>, deps: HostSqlDeps): void {
  app.post("/api/host/sql", async (c) => {
    const parsed = sqlRequestSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message ?? "invalid request" }, 400);
    }
    const { source, sql, maxRows, lobMaxBytes, pageSize } = parsed.data;
    const user = c.get("user");

    // --- ページング（pageSize 指定時）。**結果セットを保持**して続きを /next で返す ---
    if (pageSize !== undefined) {
      const opts = resolveSource(deps.resolver, source, user);
      const key = poolKey(user?.username, hostAuthFrom(opts));
      const open = () => openDb(opts);
      let conn: DbConnection | undefined;
      // **接続の確立にかかった時間とジョブを画面へ返す**。約 4.6 秒かかることがあり、
      // 「SQL が遅い」のか「接続が遅い」のかを利用者が切り分けられないため
      const connectStart = Date.now();
      let connectMs = 0;
      try {
        // 使い回した接続が相手側で切れていることがある。
        // **SQL の誤りで再試行はしない**（同じ誤りを 2 度投げるだけなので）
        let acquired = await deps.pool.acquire(key, open);
        conn = acquired.conn;
        connectMs = Date.now() - connectStart;
        let opened;
        try {
          opened = await openQuery(conn, sql);
        } catch (e) {
          if (!acquired.reused || e instanceof SqlError) throw e;
          log.debug(`pooled connection failed, retrying with a fresh one: ${String(e)}`);
          deps.pool.discard(conn);
          acquired = { conn: await open(), reused: false };
          conn = acquired.conn;
          connectMs = Date.now() - connectStart;
          opened = await openQuery(conn, sql);
        }
        const { columns, rows } = opened;
        const set = deps.resultSets.open({
          owner: user?.username,
          columns,
          rows,
          conn,
          // 読み終わったら閉じずに**プールへ返す**
          release: (used) => deps.pool.release(key, used)
        });
        const page = await deps.resultSets.next(set, pageSize);
        // **1 ページで読み切ったなら、その場で手放して接続をプールへ返す**。
        // 掴んだままにするとアイドル 60 秒のあいだ次の実行が接続を使い回せず、
        // 小さな表でも毎回 6 秒かかる（実測で気づいた）。
        // 応答は待たせない（手放しはカーソルを閉じる 1 往復ぶん遅れて完了する）
        if (!page.hasMore) void deps.resultSets.close(set.id);
        return c.json({
          // 読み切っている場合は id を返さない（続きを取りに行かせない）
          ...(page.hasMore ? { resultSetId: set.id } : {}),
          connection: connectionInfo(conn, acquired.reused, connectMs),
          columns: toColumns(columns),
          rows: toJsonRows(page.rows),
          rowCount: page.rows.length,
          hasMore: page.hasMore
        });
      } catch (e) {
        // **開けなかったら接続を残さない**（状態が分からないので使い回さない）
        if (conn) deps.pool.discard(conn);
        const err = e as As400Error;
        const detail = e instanceof SqlError ? { sqlCode: e.sqlCode, sqlState: e.sqlState } : {};
        return c.json({ error: err.message, code: err.code ?? "UNKNOWN", ...detail }, statusOf(err));
      }
    }

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

  /**
   * 接続を先に暖めておく（画面が SQL ペインを開いた時点で呼ぶ）。
   *
   * 接続の確立に約 4.6 秒かかる（うち 2.1 秒は 9471 の TLS ハンドシェイクで、
   * こちらでは短くできない）。**利用者が SQL を打っている間に済ませておく**ための入口。
   *
   * 失敗しても画面は困らない（実行時に開き直せばよいだけ）ので、
   * **暖機の失敗は 200 で返す**。ここで赤いエラーを出しても利用者にできることが無い。
   */
  app.post("/api/host/sql/warm", async (c) => {
    const parsed = warmSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message ?? "invalid request" }, 400);
    }
    const user = c.get("user");
    try {
      const opts = resolveSource(deps.resolver, parsed.data.source, user);
      const started = Date.now();
      let info: ReturnType<typeof connectionInfo> | undefined;
      await deps.pool.warm(poolKey(user?.username, hostAuthFrom(opts)), async () => {
        const conn = await openDb(opts);
        info = connectionInfo(conn, false, Date.now() - started);
        return conn;
      });
      // すでに待機中があれば開いていない（info が無い）。画面はそれで区別できる
      return c.json({ warmed: true, ...(info ? { connection: info } : {}) });
    } catch (e) {
      log.debug(`warm-up failed (実行時に開き直すので画面には出さない): ${String(e)}`);
      return c.json({ warmed: false });
    }
  });

  /** 続きを取る。**期限切れは 404**（画面が「再実行してください」と出せるように） */
  app.post("/api/host/sql/:id/next", async (c) => {
    const parsed = nextSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message ?? "invalid request" }, 400);
    }
    const user = c.get("user");
    try {
      const set = deps.resultSets.get(c.req.param("id"), user);
      if (!set) {
        return c.json({ error: "この結果セットは期限切れです。もう一度実行してください" }, 404);
      }
      const page = await deps.resultSets.next(set, parsed.data.pageSize ?? DEFAULT_ROWS);
      if (!page.hasMore) void deps.resultSets.close(set.id);
      return c.json({ rows: toJsonRows(page.rows), rowCount: page.rows.length, hasMore: page.hasMore });
    } catch (e) {
      const err = e as As400Error;
      return c.json({ error: err.message, code: err.code ?? "UNKNOWN" }, statusOf(err));
    }
  });

  /** 画面を閉じたときの後始末（任意。呼ばれなくてもアイドルで閉じる） */
  app.delete("/api/host/sql/:id", async (c) => {
    const user = c.get("user");
    try {
      const set = deps.resultSets.get(c.req.param("id"), user);
      // **手放し終えてから応答する**。画面はこれを待ってから次の SQL を実行するので、
      // ここで待たないと次の実行がプールの接続を拾えない
      if (set) await deps.resultSets.close(set.id);
      return c.json({ ok: true });
    } catch (e) {
      const err = e as As400Error;
      return c.json({ error: err.message, code: err.code ?? "UNKNOWN" }, statusOf(err));
    }
  });
}
