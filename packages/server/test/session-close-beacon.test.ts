import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { ReplayTransport, parseTraceJsonl } from "@ts5250/tn5250";
import { buildApp } from "../src/app.js";
import { SessionManager } from "../src/session-manager.js";
import { ServerConfigStore, PersonalConfigStore } from "../src/config-store.js";
import { ConfigResolver } from "../src/config-resolver.js";
import { SecretCrypto } from "../src/secret-crypto.js";
import { UserStore, SessionStore, type AuthContext } from "../src/auth.js";

/**
 * **ページを離れるときの切断通知**（`POST /api/sessions/:id/close`。`navigator.sendBeacon` の受け口）。
 * 心拍が途絶えて切れたセッションは既定で時間では切らないので、そのタブを閉じたときこの口で終わらせる。
 * 要点は、**閉じられるのは自分のセッションだけ**であること（認証オン）
 */
const here = dirname(fileURLToPath(import.meta.url));
const signon = () =>
  parseTraceJsonl(readFileSync(join(here, "..", "..", "tn5250", "test", "fixtures", "pub400-signon.jsonl"), "utf8"));
const crypto = SecretCrypto.fromEnv("K", { K: randomBytes(32).toString("hex") })!;
const resolver = () =>
  new ConfigResolver(new ServerConfigStore({ systems: [], sessions: [] }, crypto), new PersonalConfigStore({ systems: [], sessions: [] }, crypto));

describe("認証オフ", () => {
  it("閉じる。猶予中のセッションも閉じられ、同じ id をもう一度叩くと 404", async () => {
    const sessions = new SessionManager();
    const app = buildApp({ sessions, resolver: resolver(), version: "test" });
    const entry = await sessions.open({ transport: new ReplayTransport(signon()), host: "h" });
    sessions.holdForReconnect(entry.id, true);
    const res = await app.request(`/api/sessions/${entry.id}/close`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(sessions.size).toBe(0);
    expect((await app.request(`/api/sessions/${entry.id}/close`, { method: "POST" })).status).toBe(404);
  });
});

describe("認証オン", () => {
  function setup(): { app: ReturnType<typeof buildApp>; sessions: SessionManager; alice: string; bob: string } {
    const dir = mkdtempSync(join(tmpdir(), "beacon-"));
    const usersPath = join(dir, "users.json");
    writeFileSync(usersPath, JSON.stringify({ users: [] }));
    const users = UserStore.fromFile(usersPath);
    users.add("alice", "pw-alice", "user");
    users.add("bob", "pw-bob", "user");
    const auth: AuthContext = { enabled: true, users, sessions: new SessionStore() };
    const sessions = new SessionManager();
    return { app: buildApp({ sessions, resolver: resolver(), version: "test", auth }), sessions, alice: users.issueToken("alice"), bob: users.issueToken("bob") };
  }
  const bearer = (t: string): Record<string, string> => ({ authorization: `Bearer ${t}` });

  it("自分のセッションは閉じられる", async () => {
    const { app, sessions, alice } = setup();
    const entry = await sessions.open({ transport: new ReplayTransport(signon()), host: "h", owner: "alice" });
    expect((await app.request(`/api/sessions/${entry.id}/close`, { method: "POST", headers: bearer(alice) })).status).toBe(200);
    expect(sessions.size).toBe(0);
  });

  it("**他人のセッションは閉じられない**（403 で残る）", async () => {
    const { app, sessions, bob } = setup();
    const entry = await sessions.open({ transport: new ReplayTransport(signon()), host: "h", owner: "alice" });
    expect((await app.request(`/api/sessions/${entry.id}/close`, { method: "POST", headers: bearer(bob) })).status).toBe(403);
    expect(sessions.size).toBe(1);
    sessions.closeAll();
  });

  it("未認証は通らない", async () => {
    const { app, sessions } = setup();
    const entry = await sessions.open({ transport: new ReplayTransport(signon()), host: "h", owner: "alice" });
    expect((await app.request(`/api/sessions/${entry.id}/close`, { method: "POST" })).status).toBe(401);
    expect(sessions.size).toBe(1);
    sessions.closeAll();
  });
});
