import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/app.js";
import { SessionManager } from "../src/session-manager.js";
import { ConfigResolver } from "../src/config-resolver.js";
import { PersonalConfigStore, ServerConfigStore } from "../src/config-store.js";
import { AuditBuffer } from "../src/audit.js";
import { UserStore, SessionStore, hashPassword, type AuthContext } from "../src/auth.js";

/** 空の接続設定（このテストは接続設定を使わない）*/
function emptyResolver(): ConfigResolver {
  return new ConfigResolver(new ServerConfigStore(), new PersonalConfigStore());
}

/**
 * 個人利用（認証オフ）は「単一の信頼ユーザー」＝実質管理者。掴んだままのセッションを片付けられないと
 * 困るので、セッション管理とログは使えるようにする。
 * ユーザー管理はユーザーが 1 人も存在しないため登録しない（無いものを見せない）。
 */
function authCtx(): AuthContext {
  const path = join(mkdtempSync(join(tmpdir(), "adm-")), "users.json");
  writeFileSync(
    path,
    JSON.stringify({
      users: [
        { username: "root", role: "admin", passwordHash: hashPassword("rootpw") },
        { username: "alice", role: "user", passwordHash: hashPassword("alicepw") }
      ]
    })
  );
  return { enabled: true, users: UserStore.fromFile(path), sessions: new SessionStore(), cookieSecure: false };
}

function app(auth?: AuthContext) {
  return buildApp({
    sessions: new SessionManager(),
    resolver: emptyResolver(),
    audit: new AuditBuffer(),
    version: "test",
    ...(auth ? { auth } : {})
  });
}

async function login(a: ReturnType<typeof buildApp>, username: string, password: string): Promise<string> {
  const res = await a.request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password })
  });
  return res.headers.get("set-cookie")!.split(";")[0]!;
}

describe("個人利用モードの管理画面", () => {
  it("認証オフでもセッション管理が使える", async () => {
    const res = await app().request("/api/admin/sessions");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sessions: [] });
  });

  it("認証オフでもログが取得できる", async () => {
    const res = await app().request("/api/admin/logs");
    expect(res.status).toBe(200);
    expect(Array.isArray((await res.json()).events)).toBe(true);
  });

  it("認証オフではユーザー管理を登録しない（対象が存在しないため）", async () => {
    expect((await app().request("/api/admin/users")).status).toBe(404);
  });

  it("認証オン・admin は従来どおり 3 つとも使える", async () => {
    const a = app(authCtx());
    const cookie = await login(a, "root", "rootpw");
    for (const path of ["/api/admin/users", "/api/admin/sessions", "/api/admin/logs"]) {
      expect((await a.request(path, { headers: { cookie } })).status).toBe(200);
    }
  });

  it("認証オン・一般ユーザーは管理 API を使えない（回帰）", async () => {
    const a = app(authCtx());
    const cookie = await login(a, "alice", "alicepw");
    for (const path of ["/api/admin/users", "/api/admin/sessions", "/api/admin/logs"]) {
      expect((await a.request(path, { headers: { cookie } })).status).toBe(403);
    }
  });

  it("認証オン・未ログインも管理 API を使えない（回帰）", async () => {
    const a = app(authCtx());
    expect((await a.request("/api/admin/sessions")).status).toBe(401);
  });
});
