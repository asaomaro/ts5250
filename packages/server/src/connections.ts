import type { Hono } from "hono";
import { ZodError } from "zod";
import { Tn5250Error } from "@as400web/core";
import type { AuthVars } from "./auth.js";
import type { ConnectionStore } from "./connection-store.js";

/**
 * ユーザー接続設定の CRUD API（`/api/connections`）。
 * - owner スコープは ConnectionStore（assertOwner）に委譲。認証オフは全通過・認証オンは自分のみ。
 * - パスワードは body で受け取り暗号化して保存、レスポンスには含めない（PublicConnection の hasSecret のみ）。
 * - 認証ミドルウェアの配下に登録すること（保護対象 /api/*）。
 */
export interface ConnectionDeps {
  connections: ConnectionStore;
}

/** Tn5250Error / ZodError を HTTP ステータスへ写像 */
function errStatus(e: unknown): 400 | 403 | 404 {
  if (e instanceof Tn5250Error) {
    if (e.code === "FORBIDDEN") return 403;
    if (e.code === "SESSION_NOT_FOUND") return 404;
  }
  return 400; // ZodError（printer フィールド混入・型不正）・CONFIG_ERROR（鍵未設定）など
}

function errMessage(e: unknown): string {
  if (e instanceof ZodError) return e.message;
  return e instanceof Error ? e.message : String(e);
}

export function registerConnectionRoutes(app: Hono<{ Variables: AuthVars }>, deps: ConnectionDeps): void {
  const store = deps.connections;

  app.get("/api/connections", (c) => c.json({ connections: store.listForUser(c.get("user")) }));

  app.post("/api/connections", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    try {
      const created = store.add(body, c.get("user"));
      await store.save();
      return c.json({ connection: created }, 201);
    } catch (e) {
      return c.json({ error: errMessage(e) }, errStatus(e));
    }
  });

  app.put("/api/connections/:id", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    try {
      const updated = store.update(c.req.param("id"), body, c.get("user"));
      await store.save();
      return c.json({ connection: updated });
    } catch (e) {
      return c.json({ error: errMessage(e) }, errStatus(e));
    }
  });

  app.delete("/api/connections/:id", async (c) => {
    try {
      store.remove(c.req.param("id"), c.get("user"));
      await store.save();
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: errMessage(e) }, errStatus(e));
    }
  });
}
