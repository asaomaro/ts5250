import { describe, it, expect } from "vitest";
import { buildApp } from "../src/app.js";
import { SessionManager } from "../src/session-manager.js";
import { ConfigResolver } from "../src/config-resolver.js";
import { PersonalConfigStore, ServerConfigStore } from "../src/config-store.js";
import { UserStore, SessionStore, hashPassword, type AuthContext } from "../src/auth.js";
import { AuditBuffer } from "../src/audit.js";

/** 空の接続設定（このテストは接続設定を使わない）*/
function emptyResolver(): ConfigResolver {
  return new ConfigResolver(new ServerConfigStore(), new PersonalConfigStore());
}

function ctx() {
  const auth: AuthContext = {
    enabled: true,
    users: new UserStore([
      { username: "root", role: "admin", passwordHash: hashPassword("rootpw") },
      { username: "alice", role: "user", passwordHash: hashPassword("alicepw") }
    ]),
    sessions: new SessionStore()
  };
  const sessions = new SessionManager();
  const audit = new AuditBuffer();
  const app = buildApp({ sessions, resolver: emptyResolver(), version: "1", auth, audit });
  return { app, sessions, audit, auth };
}
async function login(app: ReturnType<typeof buildApp>, u: string, p: string): Promise<string> {
  const res = await app.request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: u, password: p })
  });
  return res.headers.get("set-cookie")!.split(";")[0]!;
}

describe("管理者 API", () => {
  it("非 admin は 403、admin はユーザー一覧を取得できる", async () => {
    const { app } = ctx();
    const alice = await login(app, "alice", "alicepw");
    const forbidden = await app.request("/api/admin/users", { headers: { cookie: alice } });
    expect(forbidden.status).toBe(403);

    const root = await login(app, "root", "rootpw");
    const ok = await app.request("/api/admin/users", { headers: { cookie: root } });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { users: { username: string; role: string }[] };
    expect(body.users.map((u) => u.username).sort()).toEqual(["alice", "root"]);
    expect(JSON.stringify(body)).not.toContain("passwordHash");
  });

  it("admin がユーザーを作成・トークン発行し、そのトークンで認証できる", async () => {
    const { app } = ctx();
    const root = await login(app, "root", "rootpw");
    const create = await app.request("/api/admin/users", {
      method: "POST",
      headers: { cookie: root, "content-type": "application/json" },
      body: JSON.stringify({ username: "bob", password: "bobpw", role: "user" })
    });
    expect(create.status).toBe(200);
    const tk = await app.request("/api/admin/users/bob/token", { method: "POST", headers: { cookie: root } });
    const { token } = (await tk.json()) as { token: string };
    expect(token).toMatch(/^[0-9a-f]{48}$/);
    // 発行トークンで /api/me が bob を返す
    const me = await app.request("/api/me", { headers: { authorization: `Bearer ${token}` } });
    expect(await me.json()).toEqual({ enabled: true, user: { username: "bob", role: "user" }, hasToken: true });
  });

  it("最後の admin は削除・降格できない", async () => {
    const { app } = ctx();
    const root = await login(app, "root", "rootpw");
    const del = await app.request("/api/admin/users/root", { method: "DELETE", headers: { cookie: root } });
    expect(del.status).toBe(400);
    const demote = await app.request("/api/admin/users/root", {
      method: "PUT",
      headers: { cookie: root, "content-type": "application/json" },
      body: JSON.stringify({ role: "user" })
    });
    expect(demote.status).toBe(400);
  });

  it("admin は全セッション一覧・ログを取得できる", async () => {
    const { app, audit } = ctx();
    audit.push({ op: "test_op", result: "ok" });
    const root = await login(app, "root", "rootpw");
    const sess = await app.request("/api/admin/sessions", { headers: { cookie: root } });
    expect((await sess.json())).toEqual({ sessions: [] });
    const logs = await app.request("/api/admin/logs", { headers: { cookie: root } });
    const body = (await logs.json()) as { events: { op: string }[] };
    expect(body.events.some((e) => e.op === "test_op")).toBe(true);
  });
});
