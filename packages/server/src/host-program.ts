/**
 * **プログラム呼び出し**（`POST /api/host/program`）。
 *
 * 画面を経由せずに RPG / COBOL / システム提供のプログラムを呼ぶ。
 * 下位層（`CommandConnection.call`）は既にあり、ここは**型付き引数の変換と配線**だけ。
 *
 * **数値は文字列でやり取りする**——`number` は 2^53 を超えると精度を失い、
 * 金額のような値が静かに誤る（`db/db-decimal.ts` の注記と同じ理由）。
 */
import type { Hono } from "hono";
import { z } from "zod";
import { As400Error } from "@ts5250/base";
import {
  buildServiceProgramParams,
  fromProgramOutputs,
  splitServiceProgramOutputs,
  toProgramParameters,
  type CommandConnection,
  type ProgramArg
} from "@ts5250/hostserver";
import type { AuthVars } from "./auth.js";
import type { ConfigResolver } from "./config-resolver.js";
import { openCommand } from "./host-connect.js";
import { resolveSource, sourceSchema, statusOf } from "./host-api.js";

export interface HostProgramDeps {
  resolver: ConfigResolver;
}

const argSchema = z.object({
  type: z.enum(["char", "packed", "zoned", "bin", "bytes", "null"]),
  dir: z.enum(["in", "out", "inout"]).optional(),
  /** `in` / `inout` に要る。**数値も文字列**。`bytes` は base64 */
  value: z.string().optional(),
  length: z.number().int().min(0).max(65535).optional(),
  digits: z.number().int().min(1).max(63).optional(),
  decimals: z.number().int().min(0).max(63).optional(),
  bytes: z.union([z.literal(2), z.literal(4), z.literal(8)]).optional()
});

/** サービスプログラム用。`pass` は**参照渡しが既定** */
const serviceArgSchema = argSchema.extend({
  pass: z.enum(["reference", "value"]).optional()
});

const serviceRequestSchema = z.object({
  source: sourceSchema,
  serviceProgram: z.string().min(1).max(10),
  library: z.string().min(1).max(10),
  // **API 側に上限は無い**（4007 バイトの器で通ることを実機で確認）。
  // ここの上限はこちらの都合——C++ の装飾名などは 255 を超えうる
  procedure: z.string().min(1).max(4000),
  /** 戻り値の形式。既定は `none` */
  returns: z.enum(["none", "int"]).optional(),
  args: z.array(serviceArgSchema).max(255).optional()
});

const requestSchema = z.object({
  source: sourceSchema,
  program: z.string().min(1).max(10),
  /** `*LIBL` も指定できる */
  library: z.string().min(1).max(10),
  args: z.array(argSchema).max(255).optional()
});

export function registerHostProgramRoutes(app: Hono<{ Variables: AuthVars }>, deps: HostProgramDeps): void {
  app.post("/api/host/program", async (c) => {
    const parsed = requestSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message ?? "invalid request" }, 400);
    }
    const body = parsed.data;
    const user = c.get("user");

    let conn: CommandConnection | undefined;
    try {
      const opts = resolveSource(deps.resolver, body.source, user);
      conn = await openCommand(opts);
      const args = (body.args ?? []) as ProgramArg[];
      const ccsid = opts.ccsid ?? 37;
      const { result, outputs } = await conn.call(
        body.program,
        body.library,
        toProgramParameters(args, { ccsid })
      );
      return c.json({
        success: result.success,
        returnCode: result.returnCode,
        messages: result.messages.map((m) => ({
          id: m.id,
          text: m.text,
          severity: m.severity,
          kind: m.kind
        })),
        // 引数と同じ並び。**入力専用の位置は null**
        outputs: fromProgramOutputs(args, outputs, { ccsid }).map((v) => v ?? null)
      });
    } catch (e) {
      const err = e as As400Error;
      return c.json({ error: err.message, code: err.code ?? "UNKNOWN" }, statusOf(err));
    } finally {
      conn?.close();
    }
  });

  /**
   * **サービスプログラムの手続きを呼ぶ。**
   *
   * 新しい電文は要らない——`QSYS/QZRUCLSP` という普通のプログラムが仲介する
   * （`service-program.ts` の注記）。
   */
  app.post("/api/host/service-program", async (c) => {
    const parsed = serviceRequestSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message ?? "invalid request" }, 400);
    }
    const body = parsed.data;
    const user = c.get("user");

    let conn: CommandConnection | undefined;
    try {
      const opts = resolveSource(deps.resolver, body.source, user);
      conn = await openCommand(opts);
      const ccsid = opts.ccsid ?? 37;
      const args = (body.args ?? []) as (ProgramArg & { pass?: "reference" | "value" })[];
      const params = toProgramParameters(args, { ccsid });
      const built = buildServiceProgramParams({
        serviceProgram: body.serviceProgram,
        library: body.library,
        procedure: body.procedure,
        ...(body.returns !== undefined ? { returns: body.returns } : {}),
        args: params.map((param, i) => ({
          param,
          ...(args[i]?.pass !== undefined ? { pass: args[i]!.pass! } : {})
        })),
        ccsid
      });
      const { result, outputs } = await conn.call("QZRUCLSP", "QSYS", built);
      const split = splitServiceProgramOutputs(outputs, args.length);
      return c.json({
        success: result.success,
        returnCode: result.returnCode,
        messages: result.messages.map((m) => ({
          id: m.id,
          text: m.text,
          severity: m.severity,
          kind: m.kind
        })),
        ...(body.returns === "int" ? { returnValue: split.returnValue ?? null } : {}),
        outputs: fromProgramOutputs(args, split.args, { ccsid }).map((v) => v ?? null)
      });
    } catch (e) {
      const err = e as As400Error;
      return c.json({ error: err.message, code: err.code ?? "UNKNOWN" }, statusOf(err));
    } finally {
      conn?.close();
    }
  });
}
