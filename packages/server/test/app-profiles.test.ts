import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { buildApp } from "../src/app.js";
import { SessionManager } from "../src/session-manager.js";
import { ProfileStore } from "../src/profiles.js";
import { SecretCrypto } from "../src/secret-crypto.js";
import { UserStore, SessionStore, hashPassword, type AuthContext } from "../src/auth.js";

const crypto = SecretCrypto.fromEnv("K", { K: randomBytes(32).toString("hex") })!;

/** signon + printer（信頼設定）を持つプロファイル 1 件のファイルを作る */
function profilesFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "prof-"));
  const path = join(dir, "profiles.json");
  writeFileSync(
    path,
    JSON.stringify({
      profiles: [
        {
          name: "pub400",
          host: "pub400.com",
          port: 23,
          signon: { user: "USER", passwordEnv: "PUB400_PASSWORD" },
          printer: { autoPdfDir: "/var/spool/out" }
        }
      ]
    })
  );
  return path;
}

function deps(path: string, auth?: AuthContext) {
  return {
    sessions: new SessionManager(),
    profiles: ProfileStore.fromFile(path, crypto),
    version: "test",
    ...(auth ? { auth } : {})
  };
}
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
async function login(app: ReturnType<typeof buildApp>, u: string, p: string): Promise<string> {
  const res = await app.request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: u, password: p })
  });
  return res.headers.get("set-cookie")!.split(";")[0]!;
}

describe("/api/profiles 編集（認証オフ）", () => {
  let path: string;
  beforeEach(() => (path = profilesFile()));

  it("GET は editable=true を返す", async () => {
    const app = buildApp(deps(path));
    const body = await (await app.request("/api/profiles")).json();
    expect(body.editable).toBe(true);
  });

  it("PUT で接続情報を更新でき、signon/printer（信頼設定）は保持される", async () => {
    const app = buildApp(deps(path));
    const res = await app.request("/api/profiles/pub400", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "pub400", host: "example.com", port: 992, tls: true })
    });
    expect(res.status).toBe(200);
    const saved = JSON.parse(readFileSync(path, "utf8")).profiles[0];
    expect(saved.host).toBe("example.com");
    expect(saved.tls).toBe(true);
    // 信頼設定はブラウザ入力に無くてもサーバーが保持
    expect(saved.signon.passwordEnv).toBe("PUB400_PASSWORD");
    expect(saved.printer.autoPdfDir).toBe("/var/spool/out");
  });

  it("信頼フィールド（autoPdfDir/signon）を含む入力は 400 で拒否", async () => {
    const app = buildApp(deps(path));
    const bad1 = await app.request("/api/profiles/pub400", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "pub400", host: "h", printer: { autoPdfDir: "/etc" } })
    });
    expect(bad1.status).toBe(400);
    const bad2 = await app.request("/api/profiles", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "x", host: "h", signon: { user: "u", passwordEnv: "SECRET" } })
    });
    expect(bad2.status).toBe(400);
  });

  it("DELETE でプロファイルを削除できる", async () => {
    const app = buildApp(deps(path));
    const res = await app.request("/api/profiles/pub400", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(JSON.parse(readFileSync(path, "utf8")).profiles).toHaveLength(0);
  });

  it("UI でパスワードを設定すると passwordEnc（暗号化）で保存され平文は残らない", async () => {
    const app = buildApp(deps(path));
    const res = await app.request("/api/profiles/pub400", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "pub400", host: "pub400.com", autoSignon: true, signonUser: "USER", password: "pw@1" })
    });
    expect(res.status).toBe(200);
    const raw = readFileSync(path, "utf8");
    const saved = JSON.parse(raw).profiles[0];
    expect(saved.signon.user).toBe("USER");
    expect(saved.signon.passwordEnc).toMatch(/^v1:/);
    expect(saved.signon.password).toBeUndefined();
    // 平文パスワードはファイルにもレスポンスにも現れない
    expect(raw).not.toContain("pw@1");
    // GET は signonUser を返すがパスワードは返さない
    const list = await (await app.request("/api/profiles")).json();
    expect(list.profiles[0].signonUser).toBe("USER");
    expect(JSON.stringify(list)).not.toContain("passwordEnc");
  });

  it("autoSignon をオフにすると signon が解除される", async () => {
    const app = buildApp(deps(path));
    await app.request("/api/profiles/pub400", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "pub400", host: "pub400.com", autoSignon: false })
    });
    const saved = JSON.parse(readFileSync(path, "utf8")).profiles[0];
    expect(saved.signon).toBeUndefined();
  });
});

describe("/api/profiles 編集（認証オン・admin ゲート）", () => {
  it("一般ユーザーは editable=false・書き込みは 403", async () => {
    const app = buildApp(deps(profilesFile(), authCtx()));
    const cookie = await login(app, "alice", "alicepw");
    const get = await (await app.request("/api/profiles", { headers: { cookie } })).json();
    expect(get.editable).toBe(false);
    const put = await app.request("/api/profiles/pub400", {
      method: "PUT",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "pub400", host: "h" })
    });
    expect(put.status).toBe(403);
  });

  it("admin は editable=true・書き込み可", async () => {
    const app = buildApp(deps(profilesFile(), authCtx()));
    const cookie = await login(app, "admin", "adminpw");
    const get = await (await app.request("/api/profiles", { headers: { cookie } })).json();
    expect(get.editable).toBe(true);
    const put = await app.request("/api/profiles/pub400", {
      method: "PUT",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "pub400", host: "h2" })
    });
    expect(put.status).toBe(200);
  });
});

describe("/api/profiles 編集（ファイル非由来）", () => {
  it("--profiles 未指定（persistable=false）は editable=false", async () => {
    const app = buildApp({ sessions: new SessionManager(), profiles: new ProfileStore([]), version: "test" });
    const body = await (await app.request("/api/profiles")).json();
    expect(body.editable).toBe(false);
  });
});

describe("ProfileStore: signon 解決", () => {
  it("add した password は暗号化され resolve で復号される", () => {
    const store = new ProfileStore([], crypto);
    store.add({ name: "p", host: "h", autoSignon: true, signonUser: "U", password: "secret" });
    expect(store.resolveConnectOptions("p")).toMatchObject({ user: "U", password: "secret" });
  });

  it("鍵未設定では passwordEnc を復号できず auto-signon をスキップ（warn）", () => {
    const noKey = new ProfileStore(
      [{ name: "p", host: "h", signon: { user: "U", passwordEnc: crypto.encrypt("secret") } }],
      undefined
    );
    let warned = "";
    const opts = noKey.resolveConnectOptions("p", (m) => (warned = m));
    expect(opts.password).toBeUndefined();
    expect(warned).toMatch(/secret key|decrypt/i);
  });
});
