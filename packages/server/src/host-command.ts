/**
 * **CL コマンドのプロンプト**（`POST /api/host/command/template` と `/run`）。
 *
 * IBM i の F4 に当たるもの——コマンドの定義を引き、パラメータを並べ、埋めて実行する。
 *
 * **組み立てと検証はここ（サーバー）でやる**。引用の規則は `@ts5250/hostserver` の
 * `buildCommand` にしかない。ブラウザ側に写すと二重管理になり、**片方だけ直る**。
 * UI は値の入れ物に徹する。
 */
import type { Hono } from "hono";
import { z } from "zod";
import { As400Error } from "@ts5250/base";
import {
  buildCommand,
  retrieveCommandTemplate,
  type CommandConnection,
  type CommandValue
} from "@ts5250/hostserver";
import type { AuthVars } from "./auth.js";
import type { ConfigResolver } from "./config-resolver.js";
import { openCommand } from "./host-connect.js";
import { resolveSource, sourceSchema, statusOf } from "./host-api.js";

export interface HostCommandDeps {
  resolver: ConfigResolver;
}

const templateSchema = z.object({
  source: sourceSchema,
  command: z.string().min(1).max(10),
  /** 既定は `*LIBL`。見つからなければホストが `CPF` で言う */
  library: z.string().min(1).max(10).optional()
});

const runSchema = templateSchema.extend({
  /**
   * キーワード → 値。**値は文字列か文字列の配列**（繰り返しパラメータ）。
   * 数値も文字列で受ける——`number` は桁が大きいと精度を失う（`host-program.ts` と同じ理由）。
   */
  values: z.record(z.string(), z.union([z.string(), z.array(z.string()).max(300)]))
});

export function registerHostCommandRoutes(app: Hono<{ Variables: AuthVars }>, deps: HostCommandDeps): void {
  app.post("/api/host/command/template", async (c) => {
    const parsed = templateSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message ?? "invalid request" }, 400);
    }
    const body = parsed.data;
    let conn: CommandConnection | undefined;
    try {
      conn = await openCommand(resolveSource(deps.resolver, body.source, c.get("user")));
      const tpl = await retrieveCommandTemplate(
        conn,
        body.command,
        body.library !== undefined ? { library: body.library } : {}
      );
      // **生の XML は返さない**——12KB 級になるうえ、UI は使わない。
      // 必要なら `hostserver` を直に使う経路がある
      const { xml: _xml, ...rest } = tpl;
      return c.json(rest);
    } catch (e) {
      const err = e as As400Error;
      return c.json({ error: err.message, code: err.code ?? "UNKNOWN" }, statusOf(err));
    } finally {
      conn?.close();
    }
  });

  /**
   * 組み立てと実行の共通部分。
   *
   * **組み立てだけの口を分けてある**（`/build`）——F4 の値打ちは
   * 「実行する前に、何が走るかを目で確かめられる」ところにある。
   * 画面側で引用規則を写せば下書きは作れるが、それでは**見えている文字列と
   * 実際に走る文字列が別物**になりうる。組むのは常にサーバーで、1 か所。
   */
  const buildFrom = async (body: z.infer<typeof runSchema>, conn: CommandConnection): Promise<string> => {
    const tpl = await retrieveCommandTemplate(
      conn,
      body.command,
      body.library !== undefined ? { library: body.library } : {}
    );
    const values: Record<string, CommandValue> = {};
    for (const [k, v] of Object.entries(body.values)) {
      // **空欄は送らない**＝ホストの既定に任せる（CL の作法。spec D3）
      if (typeof v === "string" && v.trim() === "") continue;
      values[k] = v;
    }
    return buildCommand(tpl, values);
  };

  app.post("/api/host/command/build", async (c) => {
    const parsed = runSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message ?? "invalid request" }, 400);
    }
    let conn: CommandConnection | undefined;
    try {
      conn = await openCommand(resolveSource(deps.resolver, parsed.data.source, c.get("user")));
      // **実行しない**。組んだ文字列だけを返す
      return c.json({ command: await buildFrom(parsed.data, conn) });
    } catch (e) {
      const err = e as As400Error;
      return c.json({ error: err.message, code: err.code ?? "UNKNOWN" }, statusOf(err));
    } finally {
      conn?.close();
    }
  });

  app.post("/api/host/command/run", async (c) => {
    const parsed = runSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message ?? "invalid request" }, 400);
    }
    let conn: CommandConnection | undefined;
    try {
      conn = await openCommand(resolveSource(deps.resolver, parsed.data.source, c.get("user")));
      const command = await buildFrom(parsed.data, conn);
      // **失敗しても throw しない**。メッセージを返すほうが呼び出し側に有用（host_command と同じ）
      const r = await conn.run(command);
      return c.json({
        // **何が走ったかを必ず返す**（spec D2）
        command,
        success: r.success,
        returnCode: r.returnCode,
        messages: r.messages.map((m) => ({
          id: m.id,
          text: m.text,
          severity: m.severity,
          kind: m.kind
        }))
      });
    } catch (e) {
      const err = e as As400Error;
      return c.json({ error: err.message, code: err.code ?? "UNKNOWN" }, statusOf(err));
    } finally {
      conn?.close();
    }
  });
}
