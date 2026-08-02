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
 * dist 直下の固定名ファイル（Vite の `public/`）が SPA フォールバックに吸われないこと。
 *
 * `/assets/*` しか静的配信していなかったので、`/favicon.svg` は **index.html の中身が
 * image/svg+xml として**返っていた。ブラウザ側にはアイコンが出ないとしか見えず、
 * dev（Vite が直接配信）では再現しないので、--web-root 経由の配信で固定する。
 */
function webRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "web-"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>ui</title>");
  writeFileSync(join(dir, "favicon.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  writeFileSync(join(dir, "favicon.ico"), Buffer.from("00000100", "hex"));
  writeFileSync(join(dir, "apple-touch-icon.png"), Buffer.from("89504e470d0a1a0a", "hex"));
  return dir;
}

function app(root: string) {
  return buildApp({
    sessions: new SessionManager(),
    resolver: emptyResolver(),
    version: "test",
    webRoot: root
  });
}

describe("アイコンの静的配信", () => {
  it.each([
    ["/favicon.svg", /image\/svg\+xml/],
    ["/favicon.ico", /image\/x-icon/],
    ["/apple-touch-icon.png", /image\/png/]
  ])("%s は実ファイルを正しい Content-Type で返す", async (path, mime) => {
    const res = await app(webRoot()).request(path);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(mime);
  });

  it("favicon.svg の中身が index.html にすり替わらない", async () => {
    const res = await app(webRoot()).request("/favicon.svg");
    expect(await res.text()).not.toMatch(/doctype html/i);
  });

  it("SPA のルーティングは従来どおり index.html を返す（回帰）", async () => {
    const res = await app(webRoot()).request("/some/client/route");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
  });
});
