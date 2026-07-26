import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { buildApp } from "../src/app.js";
import { SessionManager } from "../src/session-manager.js";
import { ServerConfigStore, PersonalConfigStore } from "../src/config-store.js";
import { ConfigResolver } from "../src/config-resolver.js";
import { MacroStore } from "../src/macro-store.js";
import { SecretCrypto } from "../src/secret-crypto.js";
import { UserStore, SessionStore, type AuthContext } from "../src/auth.js";
import type { CreateMacroBody } from "../src/macro-types.js";

/**
 * マクロ API の要点は 1 つ——**秘密がどの応答にも出ない**こと（spec D5）。
 * 所有者の分離と併せてここで固定する。
 */
const crypto = SecretCrypto.fromEnv("K", { K: randomBytes(32).toString("hex") })!;

const DUMMY_SECRET = "dummy-secret-value";

function resolver(): ConfigResolver {
  return new ConfigResolver(
    new ServerConfigStore({ systems: [], sessions: [] }, crypto),
    new PersonalConfigStore({ systems: [], sessions: [] }, crypto)
  );
}

function buildOpen(macros = new MacroStore([], crypto)): ReturnType<typeof buildApp> {
  return buildApp({ sessions: new SessionManager(), resolver: resolver(), version: "test", macros });
}

function buildWithAuth(macros = new MacroStore([], crypto)): {
  app: ReturnType<typeof buildApp>;
  aliceToken: string;
  bobToken: string;
  adminToken: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "macrousers-"));
  const usersPath = join(dir, "users.json");
  writeFileSync(usersPath, JSON.stringify({ users: [] }));
  const users = UserStore.fromFile(usersPath);
  users.add("root", "pw-root", "admin");
  users.add("alice", "pw-alice", "user");
  users.add("bob", "pw-bob", "user");
  const auth: AuthContext = { enabled: true, users, sessions: new SessionStore() };
  const app = buildApp({
    sessions: new SessionManager(),
    resolver: resolver(),
    version: "test",
    auth,
    macros
  });
  return {
    app,
    aliceToken: users.issueToken("alice"),
    bobToken: users.issueToken("bob"),
    adminToken: users.issueToken("root")
  };
}

const bearer = (t: string): Record<string, string> => ({
  authorization: `Bearer ${t}`,
  "content-type": "application/json"
});
const JSON_HEADERS = { "content-type": "application/json" };

function signonMacro(name = "サインオン"): CreateMacroBody {
  return {
    name,
    steps: [
      {
        screen: {
          rows: 24,
          cols: 80,
          targets: [
            { field: 0, row: 6, col: 53, len: 10 },
            { field: 1, row: 7, col: 53, len: 10 }
          ]
        },
        fields: [{ field: 0, value: "USER" }],
        plainSecrets: [{ field: 1, value: DUMMY_SECRET }],
        key: "Enter",
        cursor: { row: 6, col: 53 }
      }
    ]
  };
}

describe("マクロ API: CRUD（認証オフ）", () => {
  it("作成 → 一覧 → 改名 → 削除が通る", async () => {
    const app = buildOpen();

    const created = await app.request("/api/macros", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(signonMacro())
    });
    expect(created.status).toBe(201);
    const { macro } = (await created.json()) as { macro: { id: string; name: string } };
    expect(macro.name).toBe("サインオン");

    const listed = await app.request("/api/macros");
    const list = (await listed.json()) as { macros: unknown[]; canStoreSecrets: boolean };
    expect(list.macros).toHaveLength(1);
    expect(list.canStoreSecrets).toBe(true);

    const renamed = await app.request(`/api/macros/${macro.id}`, {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: "改名後" })
    });
    expect(renamed.status).toBe(200);
    expect(((await renamed.json()) as { macro: { name: string } }).macro.name).toBe("改名後");

    const removed = await app.request(`/api/macros/${macro.id}`, { method: "DELETE" });
    expect(removed.status).toBe(200);
    expect(((await (await app.request("/api/macros")).json()) as { macros: unknown[] }).macros).toHaveLength(0);
  });

  it("存在しない id の改名・削除は 404", async () => {
    const app = buildOpen();
    const put = await app.request("/api/macros/m-nope", {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: "x" })
    });
    expect(put.status).toBe(404);
    expect((await app.request("/api/macros/m-nope", { method: "DELETE" })).status).toBe(404);
  });

  it("不正な本文は 400（空ステップ・名前なし）", async () => {
    const app = buildOpen();
    const empty = await app.request("/api/macros", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: "空", steps: [] })
    });
    expect(empty.status).toBe(400);
    const noName = await app.request("/api/macros", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ steps: signonMacro().steps })
    });
    expect(noName.status).toBe(400);
  });
});

describe("マクロ API: 秘密が応答に出ない", () => {
  it("作成応答・一覧応答のいずれにも平文も暗号文も含まれない", async () => {
    const app = buildOpen();
    const created = await app.request("/api/macros", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(signonMacro())
    });
    const createdText = JSON.stringify(await created.json());
    expect(createdText).not.toContain(DUMMY_SECRET);
    expect(createdText).not.toContain("secretEnc");
    expect(createdText).not.toContain("v1:");
    expect(createdText).toContain('"hasSecret":true');
    expect(createdText).toContain('"secretFields":[1]');

    const listText = JSON.stringify(await (await app.request("/api/macros")).json());
    expect(listText).not.toContain(DUMMY_SECRET);
    expect(listText).not.toContain("secretEnc");
  });

  it("鍵が無い環境では秘密の保存を拒否し、canStoreSecrets=false を返す", async () => {
    const app = buildOpen(new MacroStore([], undefined));
    const listed = (await (await app.request("/api/macros")).json()) as { canStoreSecrets: boolean };
    expect(listed.canStoreSecrets).toBe(false);

    const res = await app.request("/api/macros", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(signonMacro())
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/secret key not configured/i);
  });
});

describe("マクロ API: 所有者の分離（認証オン）", () => {
  it("自分のマクロだけが一覧に出る", async () => {
    const { app, aliceToken, bobToken } = buildWithAuth();
    await app.request("/api/macros", {
      method: "POST",
      headers: bearer(aliceToken),
      body: JSON.stringify(signonMacro("alice のマクロ"))
    });

    const forAlice = (await (
      await app.request("/api/macros", { headers: bearer(aliceToken) })
    ).json()) as { macros: { owner?: string }[] };
    expect(forAlice.macros).toHaveLength(1);
    expect(forAlice.macros[0]!.owner).toBe("alice");

    const forBob = (await (
      await app.request("/api/macros", { headers: bearer(bobToken) })
    ).json()) as { macros: unknown[] };
    expect(forBob.macros).toHaveLength(0);
  });

  it("他人のマクロの改名・削除は 403", async () => {
    const { app, aliceToken, bobToken } = buildWithAuth();
    const created = await app.request("/api/macros", {
      method: "POST",
      headers: bearer(aliceToken),
      body: JSON.stringify(signonMacro())
    });
    const { macro } = (await created.json()) as { macro: { id: string } };

    const put = await app.request(`/api/macros/${macro.id}`, {
      method: "PUT",
      headers: bearer(bobToken),
      body: JSON.stringify({ name: "奪う" })
    });
    expect(put.status).toBe(403);
    expect(
      (await app.request(`/api/macros/${macro.id}`, { method: "DELETE", headers: bearer(bobToken) })).status
    ).toBe(403);
  });

  it("admin は他人のマクロも見える（assertOwner の既定）", async () => {
    const { app, aliceToken, adminToken } = buildWithAuth();
    await app.request("/api/macros", {
      method: "POST",
      headers: bearer(aliceToken),
      body: JSON.stringify(signonMacro())
    });
    const forAdmin = (await (
      await app.request("/api/macros", { headers: bearer(adminToken) })
    ).json()) as { macros: unknown[] };
    expect(forAdmin.macros).toHaveLength(1);
  });

  it("owner は本文で詐称できない（.strict() で弾く）", async () => {
    const { app, aliceToken } = buildWithAuth();
    const res = await app.request("/api/macros", {
      method: "POST",
      headers: bearer(aliceToken),
      body: JSON.stringify({ ...signonMacro(), owner: "bob" })
    });
    expect(res.status).toBe(400);
  });
});
