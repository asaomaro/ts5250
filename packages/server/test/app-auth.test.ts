import { describe, it, expect } from "vitest";
import { buildApp } from "../src/app.js";
import { SessionManager } from "../src/session-manager.js";
import { ProfileStore } from "../src/profiles.js";
import { UserStore, SessionStore, hashPassword, hashToken, type AuthContext } from "../src/auth.js";
import type { Transport } from "@as400web/core";

class FakeTransport implements Transport {
  private dataFn: ((d: Uint8Array) => void) | undefined;
  constructor(private readonly onStart: (t: FakeTransport) => void) {}
  send(): void {}
  close(): void {}
  onData(fn: (d: Uint8Array) => void): void {
    this.dataFn = fn;
  }
  onClose(): void {}
  onError(): void {}
  start(): void {
    this.onStart(this);
  }
  feed(rec: number[]): void {
    const out: number[] = [];
    for (const b of rec) {
      out.push(b);
      if (b === 0xff) out.push(0xff);
    }
    out.push(0xff, 0xef);
    this.dataFn?.(Uint8Array.from(out));
  }
}
const I902 = [0xc9, 0xf9, 0xf0, 0xf2];
const startup = (): number[] => {
  const body = [0x12, 0xa0, 0x90, 0x00, 0x04, 0x00, 0x00, 0x00, 0, 0, 0, 0, 0, ...I902];
  return [0x00, body.length + 2, ...body];
};
const data = (scs: number[]): number[] => {
  const body = [0x12, 0xa0, 0x01, 0x01, 0x04, 0x00, 0x00, 0x01, ...scs];
  return [0x00, body.length + 2, ...body];
};
const jobComplete = (): number[] => [0x00, 0x11, 0x12, 0xa0, 0x01, 0x01, 0x04, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0, 0];

function authCtx(): AuthContext {
  return {
    enabled: true,
    users: new UserStore([
      { username: "admin", role: "admin", passwordHash: hashPassword("adminpw"), tokenHashes: [hashToken("tk-admin")] },
      { username: "alice", role: "user", passwordHash: hashPassword("alicepw") },
      { username: "bob", role: "user", passwordHash: hashPassword("bobpw") }
    ]),
    sessions: new SessionStore()
  };
}
async function openPrinterFor(sessions: SessionManager, owner: string) {
  let t!: FakeTransport;
  const entry = await sessions.openPrinter({
    owner,
    transport: new FakeTransport((tr) => {
      t = tr;
      tr.feed(startup());
    })
  });
  t.feed(data([0xc1, 0xc2]));
  t.feed(jobComplete());
  return entry;
}

async function login(app: ReturnType<typeof buildApp>, username: string, password: string): Promise<string> {
  const res = await app.request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password })
  });
  expect(res.status).toBe(200);
  return res.headers.get("set-cookie")!.split(";")[0]!; // "sid=..."
}

describe("認証・per-user 分離", () => {
  it("認証 ON: 未認証で保護ルートは 401、login 後は Cookie で通る", async () => {
    const sessions = new SessionManager();
    const app = buildApp({ sessions, profiles: new ProfileStore([]), version: "1", auth: authCtx() });
    const entry = await openPrinterFor(sessions, "alice");

    const noauth = await app.request(`/api/spool/${entry.id}/spool-1/pdf`);
    expect(noauth.status).toBe(401);

    const cookie = await login(app, "alice", "alicepw");
    const ok = await app.request(`/api/spool/${entry.id}/spool-1/pdf`, { headers: { cookie } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("application/pdf");
  });

  it("他ユーザーのスプールは 403、admin は取得可", async () => {
    const sessions = new SessionManager();
    const app = buildApp({ sessions, profiles: new ProfileStore([]), version: "1", auth: authCtx() });
    const entry = await openPrinterFor(sessions, "alice");

    const bob = await login(app, "bob", "bobpw");
    const forbidden = await app.request(`/api/spool/${entry.id}/spool-1/pdf`, { headers: { cookie: bob } });
    expect(forbidden.status).toBe(403);

    const admin = await login(app, "admin", "adminpw");
    const adminOk = await app.request(`/api/spool/${entry.id}/spool-1/pdf`, { headers: { cookie: admin } });
    expect(adminOk.status).toBe(200);
  });

  it("Bearer トークンでも認証でき、per-user 分離が効く", async () => {
    const sessions = new SessionManager();
    const app = buildApp({ sessions, profiles: new ProfileStore([]), version: "1", auth: authCtx() });
    const entry = await openPrinterFor(sessions, "alice"); // owner=alice
    // admin トークンでは取得可、alice のスプールは admin なので OK
    const res = await app.request(`/api/spool/${entry.id}/spool-1/pdf`, {
      headers: { authorization: "Bearer tk-admin" }
    });
    expect(res.status).toBe(200);
    // 不正トークンは 401
    const bad = await app.request(`/api/spool/${entry.id}/spool-1/pdf`, { headers: { authorization: "Bearer nope" } });
    expect(bad.status).toBe(401);
  });

  it("認証 OFF: 従来どおり無認証で取得できる（後方互換）", async () => {
    const sessions = new SessionManager();
    const app = buildApp({ sessions, profiles: new ProfileStore([]), version: "1" }); // auth なし
    const entry = await openPrinterFor(sessions, "alice");
    const res = await app.request(`/api/spool/${entry.id}/spool-1/pdf`);
    expect(res.status).toBe(200);
  });

  it("/api/me は enabled と user を返す", async () => {
    const app = buildApp({ sessions: new SessionManager(), profiles: new ProfileStore([]), version: "1", auth: authCtx() });
    const off = await buildApp({ sessions: new SessionManager(), profiles: new ProfileStore([]), version: "1" }).request("/api/me");
    expect(await off.json()).toEqual({ enabled: false });
    const cookie = await login(app, "alice", "alicepw");
    const me = await app.request("/api/me", { headers: { cookie } });
    expect(await me.json()).toEqual({ enabled: true, user: { username: "alice", role: "user" } });
  });
});
