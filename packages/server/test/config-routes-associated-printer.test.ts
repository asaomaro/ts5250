import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { buildApp } from "../src/app.js";
import { SessionManager } from "../src/session-manager.js";
import { ServerConfigStore, PersonalConfigStore } from "../src/config-store.js";
import { ConfigResolver } from "../src/config-resolver.js";
import { SecretCrypto } from "../src/secret-crypto.js";
import { UserStore, SessionStore, type AuthContext } from "../src/auth.js";

/**
 * **関連付けるプリンターセッションを REST で保存・編集・削除する**（`20260921-associated-printer-session` の節目 10 の独立点検 C-M1・C-M2）。
 *
 * 以前のテストはサーバー側が **id**、web-ui 側が fetch のモックで**参照**を送る形をそれぞれ固定していて、REST の経路を通すものが 1 本も無かった——
 * UI の送る参照（`own:…`）を REST が 404 で拒み、プリンターを指した表示は画面から保存も編集もできなかった。
 * 削除も同じで、指されているプリンターを消せて、次の起動の `assertIntegrity` がサーバーを立ち上げなくした。
 *
 * 信頼境界（AGENTS.md「追加時のチェックリスト」）も認証オフ・admin・一般ユーザーの 3 パターンで固定する
 */
const crypto = SecretCrypto.fromEnv("K", { K: randomBytes(32).toString("hex") })!;

function storePath(sessions: unknown[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), "assocroute-"));
  const path = join(dir, "profiles.json");
  writeFileSync(path, JSON.stringify({ systems: [{ id: "sys", name: "sys", host: "h" }], sessions }));
  return path;
}
const build = (auth?: AuthContext, sessions: unknown[] = []) => {
  const resolver = new ConfigResolver(ServerConfigStore.fromFile(storePath(sessions), crypto), new PersonalConfigStore({ systems: [], sessions: [] }, crypto));
  return { app: buildApp({ sessions: new SessionManager(), resolver, version: "test", ...(auth ? { auth } : {}) }), resolver };
};
function buildAuth() {
  const dir = mkdtempSync(join(tmpdir(), "assocusers-"));
  const usersPath = join(dir, "users.json");
  writeFileSync(usersPath, JSON.stringify({ users: [] }));
  const users = UserStore.fromFile(usersPath);
  users.add("root", "pw-root", "admin");
  users.add("alice", "pw-alice", "user");
  users.add("bob", "pw-bob", "user");
  const auth: AuthContext = { enabled: true, users, sessions: new SessionStore() };
  return { auth, admin: users.issueToken("root"), alice: users.issueToken("alice"), bob: users.issueToken("bob") };
}
type App = ReturnType<typeof build>["app"];
const send = (app: App, method: string, path: string, body?: unknown, token?: string): Promise<Response> =>
  app.request(path, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });
const json = async <T>(r: Response): Promise<T> => (await r.json()) as T;

describe("関連付けるプリンターセッション: REST の往復（認証オフ）", () => {
  it("**UI が送る参照（srv:）で保存でき、返る参照をそのまま PUT できる**", async () => {
    const { app } = build(undefined, [{ id: "prt", name: "prt", system: "sys", sessionType: "printer" }]);
    const created = await send(app, "POST", "/api/sessions-config", {
      source: "server", name: "d", system: "srv:sys", sessionType: "display", associatedPrinterSession: "srv:prt", associatedPrinterTimeout: 10
    });
    expect(created.status).toBe(201);
    const s = (await json<{ session: { ref: string; associatedPrinterSession: string } }>(created)).session;
    expect(s.associatedPrinterSession, "参照で返る").toBe("srv:prt");
    // 一覧の値をそのまま持ち帰る（編集の往復）
    const put = await send(app, "PUT", `/api/sessions-config/${s.ref}`, {
      name: "d", system: "srv:sys", sessionType: "display", associatedPrinterSession: s.associatedPrinterSession, associatedPrinterTimeout: 20
    });
    expect(put.status).toBe(200);
    expect((await json<{ session: { associatedPrinterTimeout: number } }>(put)).session.associatedPrinterTimeout).toBe(20);
  });

  it("id のままでも保存できる（従来の書き方・設定ファイルの直書き）", async () => {
    const { app } = build(undefined, [{ id: "prt", name: "prt", system: "sys", sessionType: "printer" }]);
    const r = await send(app, "POST", "/api/sessions-config", { source: "server", name: "d", system: "srv:sys", sessionType: "display", associatedPrinterSession: "prt" });
    expect(r.status).toBe(201);
  });

  it("**指した先が無い・プリンターでない・別の保存先の参照は 400**（404 にしない）", async () => {
    const { app } = build(undefined, [
      { id: "prt", name: "prt", system: "sys", sessionType: "printer" },
      { id: "other", name: "other", system: "sys", sessionType: "display" }
    ]);
    for (const ref of ["srv:ghost", "srv:other", "own:prt"]) {
      const r = await send(app, "POST", "/api/sessions-config", { source: "server", name: "x", system: "srv:sys", sessionType: "display", associatedPrinterSession: ref });
      expect(r.status, ref).toBe(400);
    }
  });

  it("**文字列でない値は黙って捨てず 400**（数値・真偽・オブジェクトを `associatedPrinterSession` に入れても、無かったことにして保存しない）", async () => {
    const { app } = build(undefined, [{ id: "prt", name: "prt", system: "sys", sessionType: "printer" }]);
    for (const v of [123, true, { id: "prt" }, ["srv:prt"]]) {
      const r = await send(app, "POST", "/api/sessions-config", { source: "server", name: "x", system: "srv:sys", sessionType: "display", associatedPrinterSession: v });
      expect(r.status, JSON.stringify(v)).toBe(400);
    }
  });

  it("**参照されているプリンターは削除できない（403）**。関連付けを外せば消せる", async () => {
    const { app } = build(undefined, [{ id: "prt", name: "prt", system: "sys", sessionType: "printer" }]);
    const d = (await json<{ session: { ref: string } }>(
      await send(app, "POST", "/api/sessions-config", { source: "server", name: "d", system: "srv:sys", sessionType: "display", associatedPrinterSession: "srv:prt" })
    )).session;
    const del = await send(app, "DELETE", "/api/sessions-config/srv:prt");
    expect(del.status).toBe(403);
    expect((await json<{ error: string }>(del)).error).toMatch(/still associated/);
    // 関連付けを外して保存 → 消せる
    expect((await send(app, "PUT", `/api/sessions-config/${d.ref}`, { name: "d", system: "srv:sys", sessionType: "display" })).status).toBe(200);
    expect((await send(app, "DELETE", "/api/sessions-config/srv:prt")).status).toBe(200);
  });

  it("**参照されているプリンターを表示などに種別変更もできない**", async () => {
    const { app } = build(undefined, [{ id: "prt", name: "prt", system: "sys", sessionType: "printer" }]);
    await send(app, "POST", "/api/sessions-config", { source: "server", name: "d", system: "srv:sys", sessionType: "display", associatedPrinterSession: "srv:prt" });
    const r = await send(app, "PUT", "/api/sessions-config/srv:prt", { name: "prt", system: "srv:sys", sessionType: "display" });
    expect(r.status).toBe(403);
  });

  it("参照されていなければ、プリンターは今までどおり消せる・種別を変えられる", async () => {
    const { app } = build(undefined, [
      { id: "p1", name: "p1", system: "sys", sessionType: "printer" },
      { id: "p2", name: "p2", system: "sys", sessionType: "printer" }
    ]);
    expect((await send(app, "PUT", "/api/sessions-config/srv:p1", { name: "p1", system: "srv:sys", sessionType: "display" })).status).toBe(200);
    expect((await send(app, "DELETE", "/api/sessions-config/srv:p2")).status).toBe(200);
  });
});

describe("関連付けるプリンターセッション: 信頼境界（認証あり）", () => {
  it("**一般ユーザーは自分のプリンターだけ指せる**（他人のプリンター・サーバー設定のプリンターは指せない）", async () => {
    const { app, alice, bob } = (() => {
      const a = buildAuth();
      return { ...a, ...build(a.auth) };
    })();
    // alice・bob がそれぞれ自分のシステムとプリンターを作る
    const mine = async (token: string, who: string) => {
      const sys = (await json<{ system: { ref: string } }>(await send(app, "POST", "/api/systems", { name: `${who}-sys`, host: "h" }, token))).system;
      const prt = (await json<{ session: { ref: string } }>(
        await send(app, "POST", "/api/sessions-config", { name: `${who}-prt`, system: sys.ref, sessionType: "printer" }, token)
      )).session;
      return { sys, prt };
    };
    const a = await mine(alice, "alice");
    const b = await mine(bob, "bob");
    const okBody = { name: "d", system: a.sys.ref, sessionType: "display", associatedPrinterSession: a.prt.ref };
    expect((await send(app, "POST", "/api/sessions-config", okBody, alice)).status, "自分のプリンター").toBe(201);
    // 他人のプリンターの参照（alice のシステムの表示から bob のプリンターを指す）
    const other = await send(app, "POST", "/api/sessions-config", { ...okBody, name: "d2", associatedPrinterSession: b.prt.ref }, alice);
    expect(other.status, "他人のプリンター").toBeGreaterThanOrEqual(400);
    // サーバー設定のプリンターを個人の表示から指す
    const srv = await send(app, "POST", "/api/sessions-config", { ...okBody, name: "d3", associatedPrinterSession: "srv:sys" }, alice);
    expect(srv.status, "サーバー設定は指せない").toBeGreaterThanOrEqual(400);
  });

  it("**一般ユーザーは他人のプリンターの設定を消せず、自分の関連付けが指すプリンターも消せない**", async () => {
    const { app, alice, bob } = (() => {
      const a = buildAuth();
      return { ...a, ...build(a.auth) };
    })();
    const sys = (await json<{ system: { ref: string } }>(await send(app, "POST", "/api/systems", { name: "s", host: "h" }, alice))).system;
    const prt = (await json<{ session: { ref: string } }>(await send(app, "POST", "/api/sessions-config", { name: "p", system: sys.ref, sessionType: "printer" }, alice))).session;
    await send(app, "POST", "/api/sessions-config", { name: "d", system: sys.ref, sessionType: "display", associatedPrinterSession: prt.ref }, alice);
    expect((await send(app, "DELETE", `/api/sessions-config/${prt.ref}`, undefined, bob)).status, "他人").toBeGreaterThanOrEqual(403);
    expect((await send(app, "DELETE", `/api/sessions-config/${prt.ref}`, undefined, alice)).status, "自分でも指されているうちは").toBe(403);
  });

  it("**admin はサーバー設定のプリンターを指せる**（直接開くときと同じ設定を使う）", async () => {
    const a = buildAuth();
    const { app } = build(a.auth, [{ id: "prt", name: "prt", system: "sys", sessionType: "printer" }]);
    const r = await send(app, "POST", "/api/sessions-config", { source: "server", name: "d", system: "srv:sys", sessionType: "display", associatedPrinterSession: "srv:prt" }, a.admin);
    expect(r.status).toBe(201);
  });

  it("**一般ユーザーはサーバー設定の表示を作れない**（そこからプリンターを指す入口も無い）", async () => {
    const a = buildAuth();
    const { app } = build(a.auth, [{ id: "prt", name: "prt", system: "sys", sessionType: "printer" }]);
    const r = await send(app, "POST", "/api/sessions-config", { source: "server", name: "d", system: "srv:sys", sessionType: "display", associatedPrinterSession: "srv:prt" }, a.alice);
    expect(r.status).toBe(403);
  });
});
