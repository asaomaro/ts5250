import { describe, it, expect } from "vitest";
import { buildApp } from "../src/app.js";
import { SessionManager } from "../src/session-manager.js";
import { ConfigResolver } from "../src/config-resolver.js";
import { PersonalConfigStore, ServerConfigStore } from "../src/config-store.js";

function app() {
  const server = new ServerConfigStore({
    systems: [
      {
        id: "pub400",
        name: "pub400",
        host: "pub400.com",
        port: 23,
        signon: { user: "SECRETUSER", passwordEnv: "PW" }
      }
    ],
    sessions: []
  });
  return buildApp({
    sessions: new SessionManager(),
    resolver: new ConfigResolver(server, new PersonalConfigStore()),
    version: "9.9.9"
  });
}

describe("Hono app REST", () => {
  it("GET /healthz は status と session 数を返す", async () => {
    const res = await app().request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", sessions: 0 });
  });

  it("GET /api/version はバージョンを返す", async () => {
    const res = await app().request("/api/version");
    expect(await res.json()).toMatchObject({ name: "as400-5250", version: "9.9.9" });
  });

  it("GET /api/systems は認証情報を含まない", async () => {
    const res = await app().request("/api/systems");
    const body = await res.json();
    expect(body.systems[0]).toMatchObject({
      ref: "srv:pub400",
      name: "pub400",
      host: "pub400.com",
      autoSignon: true
    });
    const text = JSON.stringify(body);
    expect(text).not.toContain("SECRETUSER");
    expect(text).not.toContain("passwordEnv");
    expect(text).not.toContain('"signon"');
  });

  it("webRoot 未指定時は / でプレースホルダを返す", async () => {
    const res = await app().request("/");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("--web-root");
  });
});
