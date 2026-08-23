/**
 * SQL 実行の API（ホストサーバーの database サーバー経由）。
 *
 * **ブラウザから任意の SQL 文字列を受け取り、読み取りも更新も実行する。**
 * 一覧 API（`host-lists.ts`）が任意の CL を拒んでいるのと方針が違うので、根拠を明記する（spec D1）
 * ——SQL は**利用者が結果を見るために書く言語**で、権限の範囲を超えられない。
 * 一方あちらの CL は一覧を組み立てる内部手段で、任意の文を通す動機が無い。
 *
 * ## この経路は 2026-07-30 に読み取り専用ではなくなった
 *
 * それまでは「`query` の実装が結果セットを持たない文を実行できない」ことが事実上の
 * 歯止めになっていた（手順が `prepare + describe` → `open + describe` → `fetch` で、
 * 結果セットの無い文は describe で落ちる。実機 PUB400 で `CREATE TABLE` が作られないこと、
 * `CALL QSYS2.QCMDEXC('CRTDTAARA …')` が通らないこと、複文が `-104` で拒否されることを確認した）。
 *
 * `20260730-sql-non-query-statements` で **`executeStatement` を足し、
 * 非クエリ文（DML / DDL）をこの経路で実行できるようにした**。当時の docstring は
 * 「更新系を通す改造を入れるときは方針を再検討せよ」と書いていたので、その検討結果を残す:
 *
 *   - **書ける範囲は IBM i 側のオブジェクト権限が決める。** アプリ側で追加の制限を掛けると、
 *     ホストが許した操作を UI が勝手に禁じることになり、既存の設計思想と食い違う
 *     （`/api/host/upload` を足したときと同じ結論。`host-upload.ts`）
 *   - よって認可は他のホスト API と同じ「接続を持つユーザーなら誰でも」を踏襲する
 *   - **歯止めは「取り消せない操作を静かに成功させない」こと**に置く
 *     ——SQLCA が読めない応答は失敗として扱い、失敗した書き込みは再試行しない（`runNonQuery`）
 *
 * この経緯を残しているのは、**「なぜ以前は読み取り専用だったか」を消すと
 * 次の変更で同じ検討をやり直すことになる**ためである。
 *
 * なお読み取り範囲も IBM i の権限が決める（`host-lists.ts` と同じ原則。アプリ側で制限しない）。
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import { As400Error } from "@ts5250/base";
import { openQuery, queryLimited, executeStatement, isNonQueryStatement, SqlError, type DbConnection } from "@ts5250/hostserver";
import type { AuthVars } from "./auth.js";
import type { ConfigResolver } from "./config-resolver.js";
import { openDb, hostAuthFrom } from "./host-connect.js";
import { resolveSource, sourceSchema, statusOf } from "./host-api.js";
import type { ResultSetStore } from "./result-set-store.js";
import { poolKey, type DbPool } from "./db-pool.js";
import { childLog } from "./log.js";

const log = childLog({ component: "host-sql" });

/** 応答に載せる行数の上限（サーバー側で強制する。UI の出し分けに依存しない） */
const MAX_ROWS = 1000;
const DEFAULT_ROWS = 200;
/** LOB 1 セルあたりの上限。これ以上は受け付けない */
const MAX_LOB_BYTES = 1024 * 1024;
/**
 * `lobThreshold` の上限（15MB）。ライブラリ側の `clampLobThreshold` と同じ値。
 * **ここで先に断る**——通してから黙って丸められると、指定が効いていないことに気づけない。
 */
const MAX_LOB_THRESHOLD = 15 * 1024 * 1024;

const sqlRequestSchema = z
  .object({
    source: sourceSchema,
    sql: z.string().min(1),
    maxRows: z.number().int().positive().max(MAX_ROWS).optional(),
    /** LOB の中身も取得する。**既定では取りに行かない**（大きな LOB でメモリを掴むため） */
    lobMaxBytes: z.number().int().positive().max(MAX_LOB_BYTES).optional(),
    /** 1 度に取得する件数。指定すると結果セットを保持し、続きを /next で取れる */
    pageSize: z.number().int().positive().max(MAX_ROWS).optional(),
    /**
     * **これ以下の LOB を行データに載せて返させる**（バイト。既定 0＝載せない）。
     *
     * ロケーターを 1 つずつ引き直す往復が消える。実測（LOB セル 6 個）:
     *
     * | 実機 | 既定 0 ＋ 中身取得 | しきい値 65536 |
     * |---|---|---|
     * | 実機（LAN） | 12 往復 / 132,757B | 4 往復 / 5,078B |
     * | pub400（インターネット） | 12 往復 / 5,014ms | 4 往復 / **1,306ms** |
     *
     * ⚠ **行そのものが膨らむ**（中身を取らない既定の 982B → 5,078B）。
     * 大きくしすぎると静かにメモリを食うので上限を設けてある。
     */
    lobThreshold: z.number().int().min(0).max(MAX_LOB_THRESHOLD).optional()
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

/**
 * 結果を返さない文（DML / DDL）を実行して応答を作る。
 *
 * **クエリ経路とは応答の形を変える**（`kind: "execute"`）。列の有無で見分けさせると
 * 「列が 0 の結果セット」と区別できないため、画面が確実に分かる目印を置く。
 *
 * ## ⚠ 失敗しても再試行しない
 *
 * クエリ経路は「使い回した接続が相手側で切れていた」場合に 1 度だけ張り直す。
 * **書き込みでは同じことをしてはならない**——`execute` が届いた後に応答だけ失われた場合、
 * 張り直して投げ直すと同じ INSERT が 2 度走る。取り消せない操作なので、
 * **失敗はそのまま失敗として返し、やり直すかは利用者に決めさせる**。
 */
async function runNonQuery(
  c: Context<{ Variables: AuthVars }>,
  deps: HostSqlDeps,
  args: {
    source: z.infer<typeof sourceSchema>;
    sql: string;
    user: AuthVars["user"];
    /** 手続きが返した結果セットから読む行数の上限 */
    limit: number;
    lobMaxBytes?: number;
    /** これ以下の LOB を行データに載せさせる（接続時の属性） */
    lobThreshold?: number;
  }
): Promise<Response> {
  const connectStart = Date.now();
  let conn: DbConnection | undefined;
  let key: string | undefined;
  try {
    // **解決も try の中で行う。** 資格情報を持たない設定では `hostAuthFrom` が投げるので、
    // 外に置くと 500 になって「ユーザーとパスワードが未登録」を伝えられない
    const opts = resolveSource(deps.resolver, args.source, args.user);
    key = poolKey(args.user?.username, hostAuthFrom(opts), args.lobThreshold);
    const acquired = await deps.pool.acquire(key, () => openDb(opts, args.lobThreshold));
    conn = acquired.conn;
    const connectMs = Date.now() - connectStart;
    const result = await executeStatement(conn, args.sql, {
      resultLimit: args.limit,
      ...(args.lobMaxBytes ? { lob: { maxBytes: args.lobMaxBytes } } : {})
    });
    // **素性を採ってから手放す**。返した後は別の要求がその接続を使い始めうる
    const info = connectionInfo(conn, acquired.reused, connectMs);
    deps.pool.release(key, conn);
    return c.json({
      kind: "execute",
      updateCount: result.updateCount,
      hasRowCount: result.hasRowCount,
      ...(result.warning ? { warning: result.warning } : {}),
      // `CALL P(…, ?)` の出力パラメーター。**bigint は文字列にする**（他の経路と同じ理由）
      ...(result.outputs
        ? { outputs: result.outputs.map((v) => (typeof v === "bigint" ? v.toString() : v)) }
        : {}),
      /**
       * 手続きが返した結果セット。**クエリと同じ形の列・行で返す**ので、画面は
       * SELECT と同じ表で出せる。`kind` は `execute` のまま——出力パラメーターや
       * 「結果セット N 個」を一緒に伝える必要があり、クエリの形には入らない。
       */
      ...(result.resultSet
        ? {
            columns: toColumns(result.resultSet.columns),
            rows: toJsonRows(result.resultSet.rows),
            rowCount: result.resultSet.rows.length,
            truncated: result.resultSet.truncated
          }
        : {}),
      ...(result.resultSets !== undefined ? { resultSets: result.resultSets } : {}),
      connection: info
    });
  } catch (e) {
    // **SQL の誤りなら接続は健全**（準備で落ちただけ）。捨てると次の実行が 6 秒待たされる。
    // それ以外は状態が分からないので捨てる（クエリ経路と同じ判断）
    if (conn) {
      if (e instanceof SqlError && key !== undefined) deps.pool.release(key, conn);
      else deps.pool.discard(conn);
    }
    const err = e as As400Error;
    const detail = e instanceof SqlError ? { sqlCode: e.sqlCode, sqlState: e.sqlState } : {};
    return c.json({ error: err.message, code: err.code ?? "UNKNOWN", ...detail }, statusOf(err));
  }
}

export function registerHostSqlRoutes(app: Hono<{ Variables: AuthVars }>, deps: HostSqlDeps): void {
  app.post("/api/host/sql", async (c) => {
    const parsed = sqlRequestSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message ?? "invalid request" }, 400);
    }
    const { source, sql, maxRows, lobMaxBytes, pageSize, lobThreshold } = parsed.data;
    const user = c.get("user");

    // --- 結果を返さない文（DML / DDL）。**クエリ経路では実行できない**ので先に振り分ける ---
    if (isNonQueryStatement(sql)) {
      return await runNonQuery(c, deps, {
        source,
        sql,
        user,
        // 手続きの結果セットは**ページングしない**（カーソルを掴み続けない）ので、
        // 画面の「1 度に取得」をそのまま上限として使い、切ったら `truncated` で言う
        limit: pageSize ?? maxRows ?? DEFAULT_ROWS,
        ...(lobMaxBytes !== undefined ? { lobMaxBytes } : {}),
        ...(lobThreshold !== undefined ? { lobThreshold } : {})
      });
    }

    // --- ページング（pageSize 指定時）。**結果セットを保持**して続きを /next で返す ---
    if (pageSize !== undefined) {
      const opts = resolveSource(deps.resolver, source, user);
      const key = poolKey(user?.username, hostAuthFrom(opts), lobThreshold);
      const open = () => openDb(opts, lobThreshold);
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
          // **1 度も反復しないまま閉じても解放されるように**冪等な close を預ける（research F9）
          closeCursor: opened.close,
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
      // **上限はホストからの取得量の上限**。上限＋1 行で結果セットを打ち切る
      // （`20260730-sql-fetch-limit`）。以前は全件取得してから応答側で切っていたので、
      // 大きな表では全行がメモリに載っていた（20,000 行で 1.2MB / 2.1 秒）
      const result = await queryLimited(conn, sql, {
        limit: maxRows ?? DEFAULT_ROWS,
        ...(lobMaxBytes ? { lob: { maxBytes: lobMaxBytes } } : {})
      });
      const rows = result.rows;
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
        // **測った事実**（上限＋1 行目が読めたか）。応答側で切ったかではない
        truncated: result.truncated
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
      // **温めるのは既定（しきい値なし）の鍵だけ。** `lobThreshold` 付きは別の鍵になり、
      // そちらは使うときに張る——めったに使わない設定のために接続を寝かせない
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
