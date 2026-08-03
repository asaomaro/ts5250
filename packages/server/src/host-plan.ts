/**
 * SQL 実行計画の API（Visual Explain 相当）。
 *
 * ## 経路は 2 つあり、**特権の要否が違う**
 *
 * | 経路 | 中身 | 特権 |
 * |---|---|---|
 * | `POST /api/host/sql/explain` | **自ジョブの DB モニター**で今の文の計画を採る | **不要** |
 * | `GET /api/host/plans` | **プランキャッシュ**の上位 N（他の利用者の文も含む） | **要** |
 *
 * どちらも `20260802-sql-visual-explain` の research で実機 2 台（実機 7.3 / PUB400 7.5）に
 * 当てて確かめた。特権なしの PUB400 で、自ジョブ採取は通り、プランキャッシュは
 * `-443/38501` で拒否された。
 *
 * ## explain は**専用のプールキー**を使う
 *
 * 採取中は `STRDBMON` がその接続のジョブ全体を見ているので、**同じ接続に通常の SQL が流れると
 * 巻き込む**。既存プールは `(利用者, 接続先)` で共有されるため、キーに `"explain"` を足して分ける。
 * 毎回新規接続にしないのは、PUB400 で接続の確立に 4〜7 秒かかるため（`db-pool.ts` の実測）。
 *
 * ## 索引の作成に専用の入口を作らない
 *
 * 助言から組み立てた `CREATE INDEX` は **`/api/host/sql` に投げる**。
 * SQL ペインに同じ文を打てば通る（`isNonQueryStatement` → `executeStatement`）ので
 * **新しい権限を増やさない**うえ、監査・エラー処理・文言を既存経路と揃えられる。
 */
import { Hono } from "hono";
import { z } from "zod";
import { As400Error } from "@ts5250/base";
import {
  capturePlan,
  listPlansFromCache,
  planFromCache,
  SqlError,
  type DbConnection
} from "@ts5250/hostserver";
import type { AuthVars } from "./auth.js";
import type { ConfigResolver } from "./config-resolver.js";
import { openDb, hostAuthFrom } from "./host-connect.js";
import { resolveSource, sourceSchema, statusOf } from "./host-api.js";
import { poolKey, type DbPool } from "./db-pool.js";
import { childLog } from "./log.js";

const log = childLog({ component: "host-plan" });

/** 応答に載せる行数の上限（`host-sql.ts` と揃える） */
const MAX_ROWS = 1000;
const DEFAULT_ROWS = 200;
/** 一覧で取るプランキャッシュの件数 */
const MAX_TOP_N = 100;
const DEFAULT_TOP_N = 20;

const explainSchema = z
  .object({
    source: sourceSchema,
    sql: z.string().min(1),
    /** `no-rows` は SELECT 系のみ（行を返さずに計画だけ取る） */
    mode: z.enum(["run", "no-rows"]),
    maxRows: z.number().int().positive().max(MAX_ROWS).optional()
  })
  .strict();

/**
 * 一覧系（GET）の入力。
 *
 * **`source` をそのまま受けない。** POST は JSON の本体なので
 * `{ system, session }` のオブジェクトで受け取れるが、**クエリ文字列は文字列しか運べない**。
 * `sourceSchema`（オブジェクト）をクエリに当てると必ず 400 になる
 * ——統合検証を書いていて踏んだ。接続先は `system` / `session` の 2 つに開いて受ける。
 */
const listSchema = z
  .object({
    system: z.string().optional(),
    session: z.string().optional(),
    topN: z.coerce.number().int().positive().max(MAX_TOP_N).optional()
  })
  .strict()
  .refine((v) => Boolean(v.system ?? v.session), {
    message: "system または session を指定してください"
  });

/** クエリの `system` / `session` を `sourceSchema` の形へ戻す */
function sourceOf(q: { system?: string | undefined; session?: string | undefined }): z.infer<typeof sourceSchema> {
  return {
    ...(q.system !== undefined ? { system: q.system } : {}),
    ...(q.session !== undefined ? { session: q.session } : {})
  };
}

export interface HostPlanDeps {
  resolver: ConfigResolver;
  /** **explain 専用のキーで借りる**（通常の SQL と混線させない） */
  pool: DbPool;
}

/**
 * explain 用のプールキー。通常の SQL のキーに `"explain"` を足すだけ。
 * **同じ資格情報でも別の待機列**になるので、モニター中の接続に通常の SQL が来ない。
 */
function explainKey(owner: string | undefined, opts: { host: string; user: string; password: string }): string {
  return `${poolKey(owner, opts)} explain`;
}

/**
 * この失敗のあと、接続をプールへ返してよいか。
 *
 * `capturePlan` は `ENDDBMON` と `DROP TABLE` を `finally` で通すので、
 * **下の 2 つは「後始末が済んだうえでの失敗」**＝接続は健全。
 */
function isConnectionHealthy(e: unknown): boolean {
  if (e instanceof SqlError) return true;
  const code = (e as As400Error | undefined)?.code;
  // NOT_FOUND: 計画記録が採れなかった／一覧に id が無い
  // CONFIG_ERROR: no-rows に非クエリ文を渡した（ホストへ行く前に断っている）
  return code === "NOT_FOUND" || code === "CONFIG_ERROR";
}

/** 計画が採れなかった（＝新しい接続でやり直す価値がある）失敗か */
function isPlanUnavailable(e: unknown): boolean {
  return !(e instanceof SqlError) && (e as As400Error | undefined)?.code === "NOT_FOUND";
}

function errorResponse(e: unknown) {
  const err = e as As400Error;
  const detail = e instanceof SqlError ? { sqlCode: e.sqlCode, sqlState: e.sqlState } : {};
  return { body: { error: err.message, code: err.code ?? "UNKNOWN", ...detail }, status: statusOf(err) };
}

/** bigint は JSON にできないため文字列にする（`host-sql.ts` と同じ扱い） */
function toJsonRows(rows: readonly Record<string, unknown>[]) {
  return rows.map((r) =>
    Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v]))
  );
}

export function registerHostPlanRoutes(app: Hono<{ Variables: AuthVars }>, deps: HostPlanDeps): void {
  /**
   * 借りて使って返す。
   *
   * **接続が健全と分かるときだけプールへ返す。**
   *
   * - `SqlError`（文の誤り）— ホストが判定して返しただけ。接続は健全
   * - `NOT_FOUND` / `CONFIG_ERROR` — 採取の手前・後始末済みで落ちた。接続は健全
   *   （**捨てると、計画が採れなかっただけで次回 4〜7 秒待たされる**）
   * - それ以外 — 状態が分からないので捨てる（`STRDBMON` が残っている可能性を次の借り手に渡さない）
   */
  async function withExplainConn<T>(
    source: z.infer<typeof sourceSchema>,
    user: AuthVars["user"],
    fn: (conn: DbConnection) => Promise<T>
  ): Promise<T> {
    const opts = resolveSource(deps.resolver, source, user);
    const key = explainKey(user?.username, hostAuthFrom(opts));
    const open = (): Promise<DbConnection> => openDb(opts);
    let acquired = await deps.pool.acquire(key, open);
    try {
      const out = await fn(acquired.conn);
      deps.pool.release(key, acquired.conn);
      return out;
    } catch (e) {
      if (!isConnectionHealthy(e)) {
        deps.pool.discard(acquired.conn);
        throw e;
      }
      // **使い回した接続で計画が採れなかったら、新しい接続で 1 度だけやり直す。**
      //
      // 実機で実測: **同じ接続で同じ文を 2 回完全オープンすると、3 回目以降は
      // 最適化記録が出なくなる**（1・2 回目は 12 ノード、3 回目以降は 0 ノード）。
      // IBM i がオープン済みデータパス（ODP）を再利用して完全オープンを避けるため。
      // 文を変えれば出るので、**新しいジョブ（＝新しい接続）なら必ず出る**。
      //
      // 既存 SQL 経路の「使い回した接続が切れていたら 1 度だけ張り直す」（`host-sql.ts`）と
      // 同じ作法。`reused` のときだけ試す——新しい接続で駄目なら張り直しても同じ。
      if (!isPlanUnavailable(e) || !acquired.reused) {
        deps.pool.release(key, acquired.conn);
        throw e;
      }
      log.debug("no plan records on a reused connection; retrying once with a fresh one (ODP reuse)");
      deps.pool.discard(acquired.conn);
      acquired = { conn: await open(), reused: false };
      try {
        const out = await fn(acquired.conn);
        deps.pool.release(key, acquired.conn);
        return out;
      } catch (again) {
        if (isConnectionHealthy(again)) deps.pool.release(key, acquired.conn);
        else deps.pool.discard(acquired.conn);
        throw again;
      }
    }
  }

  app.post("/api/host/sql/explain", async (c) => {
    const parsed = explainSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message ?? "invalid request" }, 400);
    }
    const { source, sql, mode, maxRows } = parsed.data;
    const user = c.get("user");
    try {
      const captured = await withExplainConn(source, user, (conn) =>
        capturePlan(conn, sql, {
          mode,
          limit: maxRows ?? DEFAULT_ROWS,
          // **時刻は呼び出し側で採る**（採取層に時計を持ち込まない）
          at: new Date().toISOString()
        })
      );
      return c.json({
        plan: captured.plan,
        ...(captured.columns ? { columns: captured.columns.map((col) => ({ name: col.name, typeName: col.typeName })) } : {}),
        ...(captured.rows ? { rows: toJsonRows(captured.rows) } : {}),
        ...(captured.truncated !== undefined ? { truncated: captured.truncated } : {}),
        // **警告を握り潰さない**（モニターが残った可能性など）
        ...(captured.warnings.length > 0 ? { warnings: captured.warnings } : {})
      });
    } catch (e) {
      const { body, status } = errorResponse(e);
      return c.json(body, status);
    }
  });

  app.get("/api/host/plans", async (c) => {
    const parsed = listSchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message ?? "invalid request" }, 400);
    }
    const { topN } = parsed.data;
    const source = sourceOf(parsed.data);
    const user = c.get("user");
    try {
      // **権限が無くても例外にしない**——`available:false` と理由が返る（画面は履歴側へ切り替える）
      const result = await withExplainConn(source, user, (conn) =>
        listPlansFromCache(conn, topN ?? DEFAULT_TOP_N)
      );
      return c.json(result);
    } catch (e) {
      const { body, status } = errorResponse(e);
      return c.json(body, status);
    }
  });

  app.get("/api/host/plans/:id", async (c) => {
    const parsed = listSchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message ?? "invalid request" }, 400);
    }
    const { topN } = parsed.data;
    const source = sourceOf(parsed.data);
    const user = c.get("user");
    try {
      const plan = await withExplainConn(source, user, (conn) =>
        planFromCache(conn, topN ?? DEFAULT_TOP_N, c.req.param("id"), new Date().toISOString())
      );
      return c.json({ plan });
    } catch (e) {
      const { body, status } = errorResponse(e);
      return c.json(body, status);
    }
  });
}
