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
  type CommandConnection,
  listJobs,
  listObjects,
  listUsers,
  Tn5250Error
} from "@as400web/core";
import type { AuthVars } from "./auth.js";
import type { ConfigResolver } from "./config-resolver.js";
import { openCommand } from "./host-connect.js";
import { compact, resolveSource, sourceSchema, statusOf } from "./host-api.js";

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
      conn = await openCommand(resolveSource(deps.resolver, body.source, user));
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
      conn = await openCommand(resolveSource(deps.resolver, source, user));
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
