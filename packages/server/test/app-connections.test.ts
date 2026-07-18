import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { buildApp } from "../src/app.js";
import { SessionManager } from "../src/session-manager.js";
import { ProfileStore } from "../src/profiles.js";
import { ConnectionStore } from "../src/connection-store.js";
import { SecretCrypto } from "../src/secret-crypto.js";
import { UserStore, SessionStore, hashPassword, type AuthContext } from "../src/auth.js";

const crypto = SecretCrypto.fromEnv("K", { K: randomBytes(32).toString("hex") })!;

function baseDeps(connections: ConnectionStore, auth?: AuthContext) {
  const sessions = new SessionManager();
  const profiles = new ProfileStore([]);
  return { sessions, profiles, connections, version: "test", ...(auth ? { auth } : {}) };
}
function authCtx(): AuthContext {
  return {
    enabled: true,
    users: new UserStore([
      { username: "alice", role: "user", passwordHash: hashPassword("alicepw") },
      { username: "bob", role: "user", passwordHash: hashPassword("bobpw") }
    ]),
    sessions: new SessionStore()
  };
}
async function login(app: ReturnType<typeof buildApp>, username: string, password: string): Promise<string> {
  const res = await app.request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password })
  });
  return res.headers.get("set-cookie")!.split(";")[0]!;
}
const conn = (over: Record<string, unknown> = {}) => ({ name: "pub400", host: "pub400.com", ...over });

describe("/api/connections（認証オフ）", () => {
  it("誰でも作成・一覧・削除でき、全件見える", async () => {
    const app = buildApp(baseDeps(new ConnectionStore([], crypto)));
    const created = await app.request("/api/connections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(conn({ name: "c1" }))
    });
    expect(created.status).toBe(201);
    const list = await (await app.request("/api/connections")).json();
    expect(list.connections.map((c: { name: string }) => c.name)).toEqual(["c1"]);
    const id = list.connections[0].id;
    const del = await app.request(`/api/connections/${id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
  });

  it("printer 出力系フィールドを含む作成は 400", async () => {
    const app = buildApp(baseDeps(new ConnectionStore([], crypto)));
    const res = await app.request("/api/connections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(conn({ autoPdfDir: "/etc" }))
    });
    expect(res.status).toBe(400);
  });

  it("パスワードは保存されるがレスポンスに含まれず hasSecret のみ返る", async () => {
    const app = buildApp(baseDeps(new ConnectionStore([], crypto)));
    const res = await app.request("/api/connections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(conn({ autoSignon: true, signonUser: "u", password: "p@ss" }))
    });
    const body = await res.json();
    expect(body.connection.hasSecret).toBe(true);
    expect(JSON.stringify(body)).not.toContain("p@ss");
    expect(body.connection).not.toHaveProperty("secretEnc");
  });
});

describe("/api/connections（認証オン・owner 分離）", () => {
  it("自分の接続のみ一覧に出る", async () => {
    const app = buildApp(baseDeps(new ConnectionStore([], crypto), authCtx()));
    const aCookie = await login(app, "alice", "alicepw");
    const bCookie = await login(app, "bob", "bobpw");
    await app.request("/api/connections", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: aCookie },
      body: JSON.stringify(conn({ name: "alice-c" }))
    });
    const aList = await (await app.request("/api/connections", { headers: { cookie: aCookie } })).json();
    const bList = await (await app.request("/api/connections", { headers: { cookie: bCookie } })).json();
    expect(aList.connections.map((c: { name: string }) => c.name)).toEqual(["alice-c"]);
    expect(bList.connections).toEqual([]);
  });

  it("他人の接続を削除すると 403", async () => {
    const app = buildApp(baseDeps(new ConnectionStore([], crypto), authCtx()));
    const aCookie = await login(app, "alice", "alicepw");
    const bCookie = await login(app, "bob", "bobpw");
    const created = await (
      await app.request("/api/connections", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: aCookie },
        body: JSON.stringify(conn())
      })
    ).json();
    const res = await app.request(`/api/connections/${created.connection.id}`, {
      method: "DELETE",
      headers: { cookie: bCookie }
    });
    expect(res.status).toBe(403);
  });

  it("未認証では 401", async () => {
    const app = buildApp(baseDeps(new ConnectionStore([], crypto), authCtx()));
    const res = await app.request("/api/connections");
    expect(res.status).toBe(401);
  });
});

describe("/api/connections: 配線・鍵の後方互換", () => {
  it("connections 未配線なら /api/connections は登録されない（404）", async () => {
    const sessions = new SessionManager();
    const app = buildApp({ sessions, profiles: new ProfileStore([]), version: "test" });
    const res = await app.request("/api/connections");
    expect(res.status).toBe(404);
  });

  it("master key 未設定のストアで password 保存は 400", async () => {
    const app = buildApp(baseDeps(new ConnectionStore([], undefined)));
    const res = await app.request("/api/connections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(conn({ autoSignon: true, signonUser: "u", password: "p" }))
    });
    expect(res.status).toBe(400);
  });
});
