import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/app.js";
import { SessionManager } from "../src/session-manager.js";
import { ConfigResolver } from "../src/config-resolver.js";
import { PersonalConfigStore, ServerConfigStore } from "../src/config-store.js";

/** 空の接続設定（このテストは接続設定を使わない）*/
function emptyResolver(): ConfigResolver {
  return new ConfigResolver(new ServerConfigStore(), new PersonalConfigStore());
}

/**
 * SPA のフォールバック（app.get("*") → index.html）が /api/* まで拾っていたため、
 * 未登録の API パスが 200 + HTML を返していた。--web-root の有無で同じパスの応答が変わり、
 * API クライアントは JSON を期待して HTML を受け取り、タイポも 200 で隠れていた。
 */
function webRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "web-"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>ui</title>");
  return dir;
}

function app(root?: string) {
  return buildApp({
    sessions: new SessionManager(),
    resolver: emptyResolver(),
    version: "test",
    ...(root ? { webRoot: root } : {})
  });
}

describe("未登録 API パスの 404", () => {
  it("web-root ありでも JSON の 404 を返す（index.html にフォールバックしない）", async () => {
    const res = await app(webRoot()).request("/api/no-such-endpoint");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    expect((await res.json()).error).toMatch(/not found/);
  });

  it("web-root の有無で応答が変わらない", async () => {
    const withRoot = await app(webRoot()).request("/api/no-such-endpoint");
    const without = await app().request("/api/no-such-endpoint");
    expect(withRoot.status).toBe(without.status);
    expect(withRoot.status).toBe(404);
  });

  it("GET 以外のメソッドでも 404（フォールバックは get のみでメソッド差があった）", async () => {
    const a = app(webRoot());
    for (const method of ["POST", "PUT", "DELETE"]) {
      expect((await a.request("/api/no-such-endpoint", { method })).status).toBe(404);
    }
  });

  it("タイポしたパスが 200 で隠れない", async () => {
    // 正しくは /api/systems
    const res = await app(webRoot()).request("/api/system");
    expect(res.status).toBe(404);
  });

  it("既存の API は従来どおり応答する（回帰）", async () => {
    const a = app(webRoot());
    expect((await a.request("/api/version")).status).toBe(200);
    expect((await a.request("/api/systems")).status).toBe(200);
    expect((await a.request("/api/me")).status).toBe(200);
    expect((await a.request("/healthz")).status).toBe(200);
  });

  it("SPA のルーティングは従来どおり index.html を返す（/api 以外）", async () => {
    const res = await app(webRoot()).request("/some/client/route");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
  });
});
