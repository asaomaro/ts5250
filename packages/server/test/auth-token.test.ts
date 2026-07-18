import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/app.js";
import { SessionManager } from "../src/session-manager.js";
import { ProfileStore } from "../src/profiles.js";
import { UserStore, SessionStore, hashPassword, type AuthContext } from "../src/auth.js";

/**
 * API トークンは 1 ユーザー 1 本。再発行すると以前のトークンは失効する
 * （追加方式だと有効なトークンが増え続け、漏洩時にどれを消すか特定できないため）。
 */
function usersFile(extraTokenHashes?: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "tok-"));
  const path = join(dir, "users.json");
  writeFileSync(
    path,
    JSON.stringify({
      users: [
        {
          username: "alice",
          role: "user",
          passwordHash: hashPassword("alicepw"),
          ...(extraTokenHashes ? { tokenHashes: extraTokenHashes } : {})
        }
      ]
    })
  );
  return path;
}

function ctx(path: string): AuthContext {
  return { enabled: true, users: UserStore.fromFile(path), sessions: new SessionStore(), cookieSecure: false };
}
function deps(auth?: AuthContext) {
  return {
    sessions: new SessionManager(),
    profiles: new ProfileStore([]),
    version: "test",
    ...(auth ? { auth } : {})
  };
}
async function login(app: ReturnType<typeof buildApp>): Promise<string> {
  const res = await app.request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "alice", password: "alicepw" })
  });
  return res.headers.get("set-cookie")!.split(";")[0]!;
}
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

describe("API トークンの自己発行と再発行", () => {
  it("一般ユーザーが自分のトークンを発行でき、そのトークンで認証できる", async () => {
    const app = buildApp(deps(ctx(usersFile())));
    const cookie = await login(app);
    const res = await app.request("/api/me/token", { method: "POST", headers: { cookie } });
    expect(res.status).toBe(201);
    const { token } = await res.json();
    expect(token).toMatch(/^[0-9a-f]{48}$/);

    const me = await (await app.request("/api/me", { headers: bearer(token) })).json();
    expect(me.user.username).toBe("alice");
  });

  it("再発行すると以前のトークンは失効する", async () => {
    const app = buildApp(deps(ctx(usersFile())));
    const cookie = await login(app);
    const first = (await (await app.request("/api/me/token", { method: "POST", headers: { cookie } })).json()).token;
    const second = (await (await app.request("/api/me/token", { method: "POST", headers: { cookie } })).json()).token;
    expect(second).not.toBe(first);

    // 旧トークンでは認証されない（user が null）
    const old = await (await app.request("/api/me", { headers: bearer(first) })).json();
    expect(old.user).toBeNull();
    // 新トークンでは通る
    const now = await (await app.request("/api/me", { headers: bearer(second) })).json();
    expect(now.user.username).toBe("alice");
  });

  it("保存されるのはハッシュのみで、平文はファイルに残らない", async () => {
    const path = usersFile();
    const app = buildApp(deps(ctx(path)));
    const cookie = await login(app);
    const { token } = await (await app.request("/api/me/token", { method: "POST", headers: { cookie } })).json();
    const raw = readFileSync(path, "utf8");
    expect(raw).not.toContain(token);
    expect(JSON.parse(raw).users[0].tokenHashes).toHaveLength(1);
  });

  it("既存の複数トークンを持つファイルも読め、再発行で 1 本に収束する", async () => {
    const path = usersFile(["aa".repeat(32), "bb".repeat(32)]);
    const app = buildApp(deps(ctx(path)));
    const cookie = await login(app);
    await app.request("/api/me/token", { method: "POST", headers: { cookie } });
    expect(JSON.parse(readFileSync(path, "utf8")).users[0].tokenHashes).toHaveLength(1);
  });

  it("未認証では発行できない", async () => {
    const app = buildApp(deps(ctx(usersFile())));
    const res = await app.request("/api/me/token", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("認証オフでは発行できない（ユーザーが存在しないため）", async () => {
    const res = await buildApp(deps()).request("/api/me/token", { method: "POST" });
    expect(res.status).toBe(400);
  });

  it("/api/me が発行状態を返す（値そのものは返さない）", async () => {
    const app = buildApp(deps(ctx(usersFile())));
    const cookie = await login(app);
    expect((await (await app.request("/api/me", { headers: { cookie } })).json()).hasToken).toBe(false);
    await app.request("/api/me/token", { method: "POST", headers: { cookie } });
    const me = await (await app.request("/api/me", { headers: { cookie } })).json();
    expect(me.hasToken).toBe(true);
    expect(JSON.stringify(me)).not.toMatch(/[0-9a-f]{48}/);
  });
});
