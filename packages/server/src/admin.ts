import type { Hono } from "hono";
import { z } from "zod";
import { Tn5250Error } from "@as400web/core";
import { requireAdmin, type AuthContext, type AuthVars } from "./auth.js";
import type { SessionManager } from "./session-manager.js";
import type { AuditBuffer } from "./audit.js";

/**
 * 管理者（role=admin）向けの API。ユーザー管理・全セッション管理・ログ取得。
 * すべて requireAdmin ガードの下。ユーザー変更は users.json に原子的保存。
 */
export interface AdminDeps {
  auth: AuthContext;
  sessions: SessionManager;
  audit: AuditBuffer;
}

const createUserSchema = z.object({
  username: z.string().min(1).regex(/^[A-Za-z0-9._-]+$/),
  password: z.string().min(1),
  role: z.enum(["admin", "user"])
});
const updateUserSchema = z.object({
  role: z.enum(["admin", "user"]).optional(),
  password: z.string().min(1).optional()
});

/** Tn5250Error を HTTP ステータスへ */
function errStatus(e: unknown): 400 | 403 | 404 {
  if (e instanceof Tn5250Error) {
    if (e.code === "FORBIDDEN") return 403;
    if (e.code === "SESSION_NOT_FOUND") return 404;
  }
  return 400;
}

export function registerAdminRoutes(app: Hono<{ Variables: AuthVars }>, deps: AdminDeps): void {
  const users = deps.auth.users;
  app.use("/api/admin/*", requireAdmin());

  const isLastAdmin = (username: string): boolean =>
    users.listPublic().filter((u) => u.role === "admin").length === 1 &&
    users.listPublic().some((u) => u.username === username && u.role === "admin");

  // ---- ユーザー管理 ----
  app.get("/api/admin/users", (c) => c.json({ users: users.listPublic() }));

  app.post("/api/admin/users", async (c) => {
    const parsed = createUserSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    try {
      users.add(parsed.data.username, parsed.data.password, parsed.data.role);
      await users.save();
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, errStatus(e));
    }
  });

  app.put("/api/admin/users/:username", async (c) => {
    const username = c.req.param("username");
    const parsed = updateUserSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    // 最後の admin を降格させてロックアウトするのを防ぐ
    if (parsed.data.role === "user" && isLastAdmin(username)) {
      return c.json({ error: "cannot demote the last admin" }, 400);
    }
    try {
      users.update(username, {
        ...(parsed.data.role !== undefined ? { role: parsed.data.role } : {}),
        ...(parsed.data.password !== undefined ? { password: parsed.data.password } : {})
      });
      await users.save();
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, errStatus(e));
    }
  });

  app.delete("/api/admin/users/:username", async (c) => {
    const username = c.req.param("username");
    if (isLastAdmin(username)) return c.json({ error: "cannot delete the last admin" }, 400);
    try {
      users.remove(username);
      await users.save();
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, errStatus(e));
    }
  });

  app.post("/api/admin/users/:username/token", async (c) => {
    const username = c.req.param("username");
    try {
      const token = users.issueToken(username); // 平文は 1 回だけ返す
      await users.save();
      return c.json({ token });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, errStatus(e));
    }
  });

  // ---- セッション管理 ----
  app.get("/api/admin/sessions", (c) => c.json({ sessions: deps.sessions.listAll() }));

  app.delete("/api/admin/sessions/:id", async (c) => {
    try {
      await deps.sessions.close(c.req.param("id")); // admin ガード済み・全セッション対象
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, errStatus(e));
    }
  });

  // ---- ログ ----
  app.get("/api/admin/logs", (c) => c.json({ events: deps.audit.recent(200) }));
}
