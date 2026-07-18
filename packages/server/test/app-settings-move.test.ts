import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { buildApp } from "../src/app.js";
import { SessionManager } from "../src/session-manager.js";
import { ProfileStore } from "../src/profiles.js";
import { ConnectionStore } from "../src/connection-store.js";
import { SecretCrypto } from "../src/secret-crypto.js";
import { UserStore, SessionStore, hashPassword, type AuthContext } from "../src/auth.js";

const crypto = SecretCrypto.fromEnv("K", { K: randomBytes(32).toString("hex") })!;

function authCtx(): AuthContext {
  return {
    enabled: true,
    users: new UserStore([
      { username: "admin", role: "admin", passwordHash: hashPassword("adminpw") },
      { username: "alice", role: "user", passwordHash: hashPassword("alicepw") }
    ]),
    sessions: new SessionStore()
  };
}
/** profiles.json / connections.json を同一 tmp ディレクトリに作り、app と両パスを返す */
function build(profilesContent: unknown, connContent: unknown = { connections: [] }) {
  const dir = mkdtempSync(join(tmpdir(), "move-"));
  const profilesPath = join(dir, "profiles.json");
  const connFile = join(dir, "connections.json");
  writeFileSync(profilesPath, JSON.stringify(profilesContent));
  writeFileSync(connFile, JSON.stringify(connContent));
  const profiles = ProfileStore.fromFile(profilesPath, crypto);
  const connections = ConnectionStore.fromFile(connFile, crypto);
  return {
    app: buildApp({ sessions: new SessionManager(), profiles, connections, version: "test", auth: authCtx() }),
    connFile,
    profilesPath
  };
}
async function login(app: ReturnType<typeof buildApp>, u: string, p: string): Promise<string> {
  const res = await app.request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: u, password: p })
  });
  return res.headers.get("set-cookie")!.split(";")[0]!;
}
const jsonBody = (cookie: string, body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json", cookie },
  body: JSON.stringify(body)
});

describe("/api/settings/move（所有の移動・admin 限定）", () => {
  it("個人→共有: secretEnc が signon.passwordEnc へ移送され connection は消える", async () => {
    const { app, connFile, profilesPath } = build({ profiles: [] });
    const cookie = await login(app, "admin", "adminpw");
    // 個人接続を作る（パスワード付き→secretEnc）
    const created = await (
      await app.request(
        "/api/connections",
        jsonBody(cookie, { name: "mine", host: "h", autoSignon: true, signonUser: "U", password: "pw" })
      )
    ).json();
    const id = created.connection.id;
    // 共有へ移動
    const res = await app.request("/api/settings/move", jsonBody(cookie, { kind: "connection", id, to: "shared" }));
    expect(res.status).toBe(200);
    const saved = JSON.parse(readFileSync(profilesPath, "utf8")).profiles;
    expect(saved).toHaveLength(1);
    expect(saved[0].name).toBe("mine");
    expect(saved[0].signon.user).toBe("U");
    expect(saved[0].signon.passwordEnc).toMatch(/^v1:/);
    // connection は消えている
    expect(JSON.parse(readFileSync(connFile, "utf8")).connections).toHaveLength(0);
  });

  it("共有→個人: passwordEnc は secretEnc へ移送、passwordEnv/printer は破棄し warning", async () => {
    const { app, connFile, profilesPath } = build({
      profiles: [
        {
          name: "shared1",
          host: "h",
          sessionType: "printer",
          signon: { user: "U", passwordEnv: "SECRET" },
          printer: { autoPdfDir: "/out" }
        }
      ]
    });
    const cookie = await login(app, "admin", "adminpw");
    const res = await app.request(
      "/api/settings/move",
      jsonBody(cookie, { kind: "profile", id: "shared1", to: "personal" })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.warnings.join("\n")).toMatch(/passwordEnv/);
    expect(body.warnings.join("\n")).toMatch(/PDF 出力/);
    const conns = JSON.parse(readFileSync(connFile, "utf8")).connections;
    expect(conns).toHaveLength(1);
    expect(conns[0].owner).toBe("admin");
    expect(conns[0].sessionType).toBe("printer");
    expect(conns[0].secretEnc).toBeUndefined(); // passwordEnv は移送できない
    // profile は消えている
    expect(JSON.parse(readFileSync(profilesPath, "utf8")).profiles).toHaveLength(0);
  });

  it("個人→共有で同名 profile が既存なら 409（connection は残る）", async () => {
    const { app, connFile } = build({ profiles: [{ name: "dup", host: "h" }] });
    const cookie = await login(app, "admin", "adminpw");
    const created = await (
      await app.request("/api/connections", jsonBody(cookie, { name: "dup", host: "h2" }))
    ).json();
    const res = await app.request(
      "/api/settings/move",
      jsonBody(cookie, { kind: "connection", id: created.connection.id, to: "shared" })
    );
    expect(res.status).toBe(409);
    // connection は残っている
    expect(JSON.parse(readFileSync(connFile, "utf8")).connections).toHaveLength(1);
  });

  it("一般ユーザーは所有移動できない（403）", async () => {
    const { app } = build({ profiles: [] });
    const cookie = await login(app, "alice", "alicepw");
    const created = await (
      await app.request("/api/connections", jsonBody(cookie, { name: "a", host: "h" }))
    ).json();
    const res = await app.request(
      "/api/settings/move",
      jsonBody(cookie, { kind: "connection", id: created.connection.id, to: "shared" })
    );
    expect(res.status).toBe(403);
  });
});
