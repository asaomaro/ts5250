/**
 * ジョブ・オブジェクト・ユーザー一覧の API。
 *
 * ホストサーバー（コマンドサーバー）経由で取得する。**接続を持つユーザーなら誰でも使える**——
 * 見える範囲は IBM i の権限が決めるため、アプリ側で追加の制限は掛けない
 * （一般ユーザーは自分のジョブとアクセスできるオブジェクトしか見えない）。
 *
 * 操作（ジョブの保留・解放・終了、オブジェクト削除）も同じ経路で行う。
 * 失敗は IBM i のメッセージ ID とともに返す。
 */
import { Hono } from "hono";
import { z } from "zod";
import {
  childLog,
  type CommandConnection,
  listJobs,
  listObjects,
  listUsers,
  Tn5250Error,
  type ConnectOptions
} from "@as400web/core";
import type { AuthUser, AuthVars } from "./auth.js";
import type { ConfigResolver } from "./config-resolver.js";
import { openCommand } from "./host-connect.js";

/**
 * 一覧の取得元。**システムだけで足りる**——コマンドサーバーは装置名も画面サイズも使わないため。
 * セッション設定を指定してもよい（親システムに解決される）が、必須ではない。
 */
const sourceSchema = z
  .object({
    system: z.string().optional(),
    session: z.string().optional()
  })
  .strict()
  .refine((v) => Boolean(v.system ?? v.session), {
    message: "system または session を指定してください"
  });

const jobFilterSchema = z
  .object({ name: z.string().optional(), user: z.string().optional(), type: z.string().optional() })
  .strict();

const objectFilterSchema = z
  .object({ name: z.string().optional(), library: z.string().optional(), type: z.string().optional() })
  .strict();

const userFilterSchema = z
  .object({ selection: z.enum(["*USER", "*GROUP", "*MEMBER"]).optional() })
  .strict();

const listRequestSchema = z
  .object({
    source: sourceSchema,
    jobs: jobFilterSchema.optional(),
    objects: objectFilterSchema.optional(),
    users: userFilterSchema.optional(),
    max: z.number().int().positive().max(1000).optional()
  })
  .strict();

/** 操作。破壊的なものを含むため対象を明示的に列挙する */
const actionSchema = z
  .object({
    source: sourceSchema,
    /** 実行する CL コマンド。**この API が組み立てる**（利用側から任意の CL は受け取らない） */
    action: z.enum(["job-hold", "job-release", "job-end", "object-delete"]),
    target: z
      .object({
        jobName: z.string().optional(),
        jobUser: z.string().optional(),
        jobNumber: z.string().optional(),
        objectName: z.string().optional(),
        objectLibrary: z.string().optional(),
        objectType: z.string().optional()
      })
      .strict()
  })
  .strict();

export interface HostListDeps {
  /** 接続設定の唯一の解決点 */
  resolver: ConfigResolver;
}

const listLog = childLog({ component: "host-lists" });

/**
 * エラーを HTTP ステータスへ写す。
 *
 * **502 は「上流（IBM i）との通信に失敗した」意味に限る。**
 * 設定の誤りや認可の失敗まで 502 にすると、呼び出し側が
 * 「ホストが落ちている」のか「指定が間違っている」のかを区別できない。
 * 写像は connections 側と揃える（旧実装は一律 502 だった）。
 */
function statusOf(e: Tn5250Error): 400 | 403 | 404 | 502 {
  switch (e.code) {
    case "FORBIDDEN":
      return 403;
    case "SESSION_NOT_FOUND":
      return 404;
    case "CONFIG_ERROR":
    case "CONNECT_FAILED":
      return 400;
    default:
      return 502;
  }
}


/**
 * 未指定（undefined）の項目を落とす。
 * `exactOptionalPropertyTypes` のため、`{ user: undefined }` は
 * 「指定していない」ではなく「undefined を指定した」になってしまう。
 */
function compact<T extends object>(value: T | undefined): {
  [K in keyof T]-?: Exclude<T[K], undefined>;
} {
  if (!value) return {} as never;
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined)
  ) as never;
}

/** 接続設定から資格情報を解く。ブラウザへは渡さない */
function resolveSource(
  deps: HostListDeps,
  source: z.infer<typeof sourceSchema>,
  user: AuthUser | undefined
): ConnectOptions {
  return deps.resolver.resolve(
    { system: source.system, session: source.session },
    user,
    (m) => listLog.warn(m)
  ).connect;
}

/** 操作から CL コマンドを組み立てる。**利用側から任意の CL は受け取らない** */
function buildCommand(
  action: z.infer<typeof actionSchema>["action"],
  target: z.infer<typeof actionSchema>["target"]
): string {
  const job = (): string => {
    if (!target.jobNumber || !target.jobUser || !target.jobName) {
      throw new Tn5250Error("CONFIG_ERROR", "ジョブの指定が不完全です");
    }
    return `${target.jobNumber}/${target.jobUser}/${target.jobName}`;
  };
  switch (action) {
    case "job-hold":
      return `HLDJOB JOB(${job()})`;
    case "job-release":
      return `RLSJOB JOB(${job()})`;
    case "job-end":
      return `ENDJOB JOB(${job()}) OPTION(*CNTRLD) DELAY(30)`;
    case "object-delete": {
      if (!target.objectName || !target.objectLibrary || !target.objectType) {
        throw new Tn5250Error("CONFIG_ERROR", "オブジェクトの指定が不完全です");
      }
      return `DLTOBJ OBJ(${target.objectLibrary}/${target.objectName}) OBJTYPE(${target.objectType})`;
    }
  }
}

export function registerHostListRoutes(app: Hono<{ Variables: AuthVars }>, deps: HostListDeps): void {
  /** 一覧の取得 */
  app.post("/api/host/list/:kind", async (c) => {
    const kind = c.req.param("kind");
    if (kind !== "jobs" && kind !== "objects" && kind !== "users") {
      return c.json({ error: `unknown list kind: ${kind}` }, 404);
    }
    const parsed = listRequestSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message ?? "invalid request" }, 400);
    }
    const body = parsed.data;
    const user = c.get("user");

    let conn: CommandConnection | undefined;
    try {
      conn = await openCommand(resolveSource(deps, body.source, user));
      const max = body.max ?? 200;
      const items =
        kind === "jobs"
          ? await listJobs(conn, compact(body.jobs), { max })
          : kind === "objects"
            ? await listObjects(conn, compact(body.objects), { max })
            : await listUsers(conn, compact(body.users), { max });
      return c.json({ items });
    } catch (e) {
      const err = e as Tn5250Error;
      return c.json({ error: err.message, code: err.code ?? "UNKNOWN" }, statusOf(err));
    } finally {
      conn?.close();
    }
  });

  /** 操作の実行 */
  app.post("/api/host/action", async (c) => {
    const parsed = actionSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message ?? "invalid request" }, 400);
    }
    const { source, action, target } = parsed.data;
    const user = c.get("user");

    let conn: CommandConnection | undefined;
    try {
      const command = buildCommand(action, target);
      conn = await openCommand(resolveSource(deps, source, user));
      const result = await conn.run(command);
      return c.json({
        success: result.success,
        command,
        messages: result.messages.map((m) => ({
          id: m.id,
          text: m.text,
          severity: m.severity,
          kind: m.kind
        }))
      });
    } catch (e) {
      const err = e as Tn5250Error;
      return c.json({ error: err.message, code: err.code ?? "UNKNOWN" }, statusOf(err));
    } finally {
      conn?.close();
    }
  });
}
