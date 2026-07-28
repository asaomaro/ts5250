import { describe, it, expect, beforeEach } from "vitest";
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
 * 信頼境界の 2〜4 層目を確認する（1 層目＝スキーマ、5 層目＝解決点は別テスト）。
 *
 * printer 出力（`autoPdfDir` 等）は **サーバー上の任意パスへのファイル書き込み**に直結する
 * （printer-output.ts が設定値をそのまま join に渡す）。多層で守っているのは、
 * 1 層でも破れると実害が出るため。
 */
const crypto = SecretCrypto.fromEnv("K", { K: randomBytes(32).toString("hex") })!;

function serverStorePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "cfgroute-"));
  const path = join(dir, "profiles.json");
  writeFileSync(path, JSON.stringify({ systems: [{ id: "sys", name: "sys", host: "h" }], sessions: [] }));
  return path;
}

interface Built {
  app: ReturnType<typeof buildApp>;
  resolver: ConfigResolver;
}

/** auth を有効にしたアプリ。admin と一般ユーザーのトークンを返す */
function buildWithAuth(): Built & { adminToken: string; userToken: string } {
  const dir = mkdtempSync(join(tmpdir(), "cfgusers-"));
  const usersPath = join(dir, "users.json");
  writeFileSync(usersPath, JSON.stringify({ users: [] }));
  const users = UserStore.fromFile(usersPath);
  users.add("root", "pw-root", "admin");
  users.add("alice", "pw-alice", "user");
  const adminToken = users.issueToken("root");
  const userToken = users.issueToken("alice");
  const auth: AuthContext = { enabled: true, users, sessions: new SessionStore() };

  const resolver = new ConfigResolver(
    ServerConfigStore.fromFile(serverStorePath(), crypto),
    new PersonalConfigStore({ systems: [], sessions: [] }, crypto)
  );
  const app = buildApp({ sessions: new SessionManager(), resolver, version: "test", auth });
  return { app, resolver, adminToken, userToken };
}

/** 認証オフのアプリ（＝単一の信頼ユーザー） */
function buildOpen(): Built {
  const resolver = new ConfigResolver(
    ServerConfigStore.fromFile(serverStorePath(), crypto),
    new PersonalConfigStore({ systems: [], sessions: [] }, crypto)
  );
  return { app: buildApp({ sessions: new SessionManager(), resolver, version: "test" }), resolver };
}

function post(app: Built["app"], path: string, body: unknown, token?: string): Promise<Response> {
  return app.request(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body)
  });
}

describe("信頼境界 2 層目: サーバー設定への書き込みは admin のみ", () => {
  let ctx: ReturnType<typeof buildWithAuth>;
  beforeEach(() => {
    ctx = buildWithAuth();
  });

  it("一般ユーザーはサーバー設定のシステムを作れない", async () => {
    const res = await post(ctx.app, "/api/systems", { source: "server", name: "x", host: "h" }, ctx.userToken);
    expect(res.status).toBe(403);
  });

  it("一般ユーザーはサーバー設定のセッションを作れない（printer の入口）", async () => {
    const res = await post(
      ctx.app,
      "/api/sessions-config",
      { source: "server", name: "p", system: "srv:sys", sessionType: "printer", printer: { autoPdfDir: "/etc" } },
      ctx.userToken
    );
    expect(res.status).toBe(403);
  });

  it("admin は作れる", async () => {
    const res = await post(ctx.app, "/api/systems", { source: "server", name: "x", host: "h" }, ctx.adminToken);
    expect(res.status).toBe(201);
  });

  it("一般ユーザーでも自分の個人設定は作れる", async () => {
    const res = await post(ctx.app, "/api/systems", { name: "mine", host: "h" }, ctx.userToken);
    expect(res.status).toBe(201);
  });

  it("一般ユーザーにサーバー設定は見えない", async () => {
    const res = await ctx.app.request("/api/systems", {
      headers: { authorization: `Bearer ${ctx.userToken}` }
    });
    const body = (await res.json()) as { systems: { ref: string }[]; editable: boolean };
    expect(body.systems.every((s) => s.ref.startsWith("own:"))).toBe(true);
    expect(body.editable).toBe(false);
  });
});

describe("信頼境界 3 層目: display 種別では printer 出力を落とす", () => {
  it("display セッションに printer を送っても保存されない", async () => {
    const { app, resolver } = buildOpen();
    const res = await post(app, "/api/sessions-config", {
      source: "server",
      name: "d",
      system: "srv:sys",
      sessionType: "display",
      printer: { autoPdfDir: "/var/spool/out" }
    });
    expect(res.status).toBe(201);
    const store = resolver.storeOf("server");
    const saved = store.getSession("d") as { printer?: unknown };
    expect(saved.printer).toBeUndefined();
  });

  it("display なら不正な autoPdfDir でも 400 にしない（どのみち破棄されるため）", async () => {
    const { app } = buildOpen();
    const res = await post(app, "/api/sessions-config", {
      source: "server",
      name: "d2",
      system: "srv:sys",
      sessionType: "display",
      printer: { autoPdfDir: "/nonexistent/definitely/not/here" }
    });
    expect(res.status).toBe(201);
  });
});

describe("信頼境界 4 層目: autoPdfDir を保存前に検証する", () => {
  it("存在しないディレクトリは 400 で弾き、保存しない", async () => {
    const { app, resolver } = buildOpen();
    const res = await post(app, "/api/sessions-config", {
      source: "server",
      name: "p",
      system: "srv:sys",
      sessionType: "printer",
      printer: { autoPdfDir: "/nonexistent/definitely/not/here" }
    });
    expect(res.status).toBe(400);
    expect(() => resolver.storeOf("server").getSession("p")).toThrow();
  });

  it("存在するディレクトリなら通り、解決後のパスを返す", async () => {
    const { app } = buildOpen();
    const dir = mkdtempSync(join(tmpdir(), "pdfout-"));
    const res = await post(app, "/api/sessions-config", {
      source: "server",
      name: "p2",
      system: "srv:sys",
      sessionType: "printer",
      printer: { autoPdfDir: dir }
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { resolvedPdfDir?: string };
    expect(body.resolvedPdfDir).toBeTruthy();
  });
});

describe("信頼境界 1 層目の再確認: 個人設定は printer を持てない", () => {
  it("個人セッションに printer を送ると 400（スキーマが弾く）", async () => {
    const { app } = buildOpen();
    await post(app, "/api/systems", { name: "own-sys", host: "h" });
    const list = (await (await app.request("/api/systems")).json()) as { systems: { ref: string; name: string }[] };
    const own = list.systems.find((s) => s.name === "own-sys")!;
    const res = await post(app, "/api/sessions-config", {
      name: "p",
      system: own.ref,
      sessionType: "printer",
      printer: { autoPdfDir: "/etc" }
    });
    expect(res.status).toBe(400);
  });
});

describe("CRUD", () => {
  it("システムを作って一覧に出る", async () => {
    const { app } = buildOpen();
    const created = await post(app, "/api/systems", { name: "new", host: "h2", tls: true });
    expect(created.status).toBe(201);
    const body = (await (await app.request("/api/systems")).json()) as {
      systems: { name: string; host: string; tls?: boolean }[];
    };
    expect(body.systems.find((s) => s.name === "new")).toMatchObject({ host: "h2", tls: true });
  });

  it("パスワードは応答に出ない（有無だけ）", async () => {
    const { app } = buildOpen();
    const res = await post(app, "/api/systems", {
      name: "cred",
      host: "h3",
      autoSignon: true,
      signonUser: "USER",
      password: "s3cret"
    });
    const json = JSON.stringify(await res.json());
    expect(json).not.toContain("s3cret");
    expect(json).not.toContain("USER");
    expect(json).toContain('"autoSignon":true');
  });

  it("子セッションが残っているシステムは削除できない", async () => {
    const { app } = buildOpen();
    await post(app, "/api/sessions-config", {
      source: "server",
      name: "child",
      system: "srv:sys",
      sessionType: "display"
    });
    const res = await app.request("/api/systems/srv:sys", { method: "DELETE" });
    expect(res.status).toBe(403);
  });

  it("壊れた参照は 400", async () => {
    const { app } = buildOpen();
    const res = await app.request("/api/systems/no-prefix", { method: "DELETE" });
    expect(res.status).toBe(400);
  });
});

describe("回帰: 資格情報を黙って消さない", () => {
  /**
   * 一覧の応答には**パスワードが含まれない**（含めてはならない）ので、
   * UI は「フォームをそのまま送り返す」形で更新する。このとき資格情報に触れていない更新で
   * signon ごと落ちると、**接続できなくなった理由が分からない**形で壊れる。
   * 旧実装は「autoSignon 未指定＝既存を保つ」で守っていた。
   */
  it("名前だけ変える更新でパスワードが残る", async () => {
    const { app, resolver } = buildOpen();
    const created = await post(app, "/api/systems", {
      name: "cred",
      host: "h",
      autoSignon: true,
      signonUser: "USER",
      password: "s3cret"
    });
    const ref = ((await created.json()) as { system: { ref: string } }).system.ref;

    const res = await app.request(`/api/systems/${ref}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      // 一覧の応答をそのまま送り返した想定（password は含まれない）
      body: JSON.stringify({ name: "cred2", host: "h" })
    });
    expect(res.status).toBe(200);

    const store = resolver.storeOf("personal");
    const sys = store.getSystem(ref.replace(/^own:/, ""));
    expect(sys.name).toBe("cred2");
    expect(sys.signon?.user).toBe("USER");
    expect(sys.signon?.passwordEnc).toBeTruthy();
  });

  it("autoSignon:false を明示したときは解除される", async () => {
    const { app, resolver } = buildOpen();
    const created = await post(app, "/api/systems", {
      name: "cred",
      host: "h",
      autoSignon: true,
      signonUser: "USER",
      password: "s3cret"
    });
    const ref = ((await created.json()) as { system: { ref: string } }).system.ref;
    await app.request(`/api/systems/${ref}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "cred", host: "h", autoSignon: false })
    });
    const sys = resolver.storeOf("personal").getSystem(ref.replace(/^own:/, ""));
    expect(sys.signon).toBeUndefined();
  });

  it("編集フォーム用にユーザー名は返るが、パスワードは返らない", async () => {
    const { app } = buildOpen();
    await post(app, "/api/systems", {
      name: "cred",
      host: "h",
      autoSignon: true,
      signonUser: "USER",
      password: "s3cret"
    });
    const body = await (await app.request("/api/systems")).json();
    const json = JSON.stringify(body);
    expect(json).toContain("USER");
    expect(json).not.toContain("s3cret");
    expect(json).not.toContain("passwordEnc");
  });
});

/**
 * PC コマンド（STRPCCMD）は**サーバー機での任意コマンド実行**。
 * printer 出力より強い権限にあたるので、同じ層で守れていることを route 越しに確かめる。
 */
describe("信頼境界: PC コマンド（STRPCCMD）", () => {
  it("一般ユーザーはサーバー設定のセッション（実行の入口）を作れない", async () => {
    const ctx = buildWithAuth();
    const res = await post(
      ctx.app,
      "/api/sessions-config",
      {
        source: "server",
        name: "d",
        system: "srv:sys",
        sessionType: "display",
        pcCommand: { enabled: true }
      },
      ctx.userToken
    );
    expect(res.status).toBe(403);
  });

  it("個人設定へ送るとスキーマで弾かれる（1 層目。後段で落とす形にしない）", async () => {
    const ctx = buildWithAuth();
    await post(ctx.app, "/api/systems", { name: "mine", host: "h" }, ctx.userToken);
    const list = (await (
      await ctx.app.request("/api/systems", { headers: { authorization: `Bearer ${ctx.userToken}` } })
    ).json()) as { systems: { ref: string }[] };
    const res = await post(
      ctx.app,
      "/api/sessions-config",
      { name: "d", system: list.systems[0]!.ref, sessionType: "display", pcCommand: { enabled: true } },
      ctx.userToken
    );
    expect(res.status).toBe(400);
  });

  it("3 層目: printer 種別に送っても保存されない（画面の標識でしか届かないため）", async () => {
    const { app, resolver } = buildOpen();
    const res = await post(app, "/api/sessions-config", {
      source: "server",
      name: "p",
      system: "srv:sys",
      sessionType: "printer",
      pcCommand: { enabled: true }
    });
    expect(res.status).toBe(201);
    const saved = resolver.storeOf("server").getSession("p") as { pcCommand?: unknown };
    expect(saved.pcCommand).toBeUndefined();
  });

  it("4 層目: 壊れた許可パターンは保存前に 400 で弾く", async () => {
    const { app } = buildOpen();
    const res = await post(app, "/api/sessions-config", {
      source: "server",
      name: "d",
      system: "srv:sys",
      sessionType: "display",
      pcCommand: { enabled: true, allow: ["ok.*", "("] }
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/invalid allow pattern/);
  });

  it("認証オフ（＝単一の信頼ユーザー）なら保存でき、編集用に値が返る", async () => {
    const { app } = buildOpen();
    const res = await post(app, "/api/sessions-config", {
      source: "server",
      name: "d",
      system: "srv:sys",
      sessionType: "display",
      pcCommand: { enabled: true, allow: ["echo .*"] }
    });
    expect(res.status).toBe(201);
    const list = (await (await app.request("/api/sessions-config")).json()) as {
      sessions: { ref: string; pcCommand?: { enabled?: boolean; allow?: string[] } }[];
    };
    expect(list.sessions[0]?.pcCommand).toEqual({ enabled: true, allow: ["echo .*"] });
  });
});
