import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { PersonalConfigStore, ServerConfigStore } from "../src/config-store.js";
import { ConfigResolver } from "../src/config-resolver.js";
import { SecretCrypto } from "../src/secret-crypto.js";
import type { AuthUser } from "../src/auth.js";

/**
 * PC コマンド（STRPCCMD）の信頼境界。
 *
 * これは**サーバー機での任意コマンド実行**なので、`printer` 出力と同じ 5 層で守る。
 * 「一般ユーザーの入力から実行設定が入らない」ことを層ごとに固定する
 * （UI の出し分けは補助であって境界ではない。AGENTS.md「認可はサーバーで担保する」）。
 */
const crypto = SecretCrypto.fromEnv("K", { K: randomBytes(32).toString("hex") })!;
const alice: AuthUser = { username: "alice", role: "user" };
const admin: AuthUser = { username: "root", role: "admin" };

const personalStore = (): PersonalConfigStore =>
  new PersonalConfigStore(
    { systems: [{ id: "s-1", name: "sys", host: "h", owner: "alice" }], sessions: [] },
    crypto
  );
const serverStore = (): ServerConfigStore =>
  new ServerConfigStore({ systems: [{ id: "sys", name: "sys", host: "h" }], sessions: [] }, crypto);

describe("1 層目: 個人設定のスキーマに pcCommand が無い", () => {
  it("個人設定へ入れようとすると parse で落ちる（後段で落とす形にしない）", () => {
    const store = personalStore();
    expect(() =>
      store.addSession(
        {
          name: "d",
          system: "s-1",
          sessionType: "display",
          pcCommand: { enabled: true }
        },
        alice
      )
    ).toThrow();
  });

  it("サーバー設定なら持てる", () => {
    const store = serverStore();
    const s = store.addSession(
      {
        name: "d",
        system: "sys",
        sessionType: "display",
        pcCommand: { enabled: true, timeoutMs: 5000, allow: ["echo .*"] }
      },
      admin
    );
    expect(s.ref).toBe("srv:d");
  });
});

describe("露出: 値は編集できる相手にだけ返す", () => {
  it("includeTrusted 無しでは値を返さない", () => {
    const store = serverStore();
    store.addSession(
      { name: "d", system: "sys", sessionType: "display", pcCommand: { enabled: true, allow: ["echo .*"] } },
      admin
    );
    const listed = store.listSessions(admin);
    expect(listed[0]?.pcCommand).toBeUndefined();
  });

  it("includeTrusted なら値ごと返る（保存で消えないよう往復させるため）", () => {
    const store = serverStore();
    store.addSession(
      { name: "d", system: "sys", sessionType: "display", pcCommand: { enabled: true, allow: ["echo .*"] } },
      admin
    );
    const listed = store.listSessions(admin, { includeTrusted: true });
    expect(listed[0]?.pcCommand).toEqual({ enabled: true, allow: ["echo .*"] });
  });

  it("返す値は複製（応答を書き換えてもストアに届かない）", () => {
    const store = serverStore();
    store.addSession(
      { name: "d", system: "sys", sessionType: "display", pcCommand: { enabled: true } },
      admin
    );
    const listed = store.listSessions(admin, { includeTrusted: true });
    listed[0]!.pcCommand!.enabled = false;
    expect(store.listSessions(admin, { includeTrusted: true })[0]?.pcCommand?.enabled).toBe(true);
  });
});

describe("2 層目: サーバー設定は一般ユーザーから触れない", () => {
  it("一般ユーザーはサーバー設定のセッションを見られない（FORBIDDEN）", () => {
    const store = serverStore();
    store.addSession(
      { name: "d", system: "sys", sessionType: "display", pcCommand: { enabled: true } },
      admin
    );
    expect(store.listSessions(alice, { includeTrusted: true })).toEqual([]);
  });
});

describe("5 層目: 解決器はサーバー設定の display からしか実行設定を渡さない", () => {
  it("サーバー設定の display セッションなら渡る", () => {
    const server = serverStore();
    server.addSession(
      {
        name: "d",
        system: "sys",
        sessionType: "display",
        pcCommand: { enabled: true, timeoutMs: 1000, allow: ["echo .*"], cwd: "/tmp" }
      },
      admin
    );
    const resolver = new ConfigResolver(server, undefined);
    const t = resolver.resolve({ session: "srv:d" }, undefined, () => {});
    expect(t.pcCommand).toEqual({ enabled: true, timeoutMs: 1000, allow: ["echo .*"], cwd: "/tmp" });
  });

  it("プリンターセッションには渡らない（PC コマンドは 5250 画面の標識でしか届かない）", () => {
    const server = serverStore();
    // スキーマ上は持てるので、ここで種別により落ちることを確かめる
    server.addSession(
      { name: "p", system: "sys", sessionType: "printer", pcCommand: { enabled: true } },
      admin
    );
    const resolver = new ConfigResolver(server, undefined);
    const t = resolver.resolve({ session: "srv:p" }, undefined, () => {});
    expect(t.pcCommand).toBeUndefined();
  });

  it("個人設定のセッションには渡らない（そもそも持てない）", () => {
    const personal = personalStore();
    personal.addSession({ name: "d", system: "s-1", sessionType: "display" }, alice);
    const resolver = new ConfigResolver(undefined, personal);
    const sessions = personal.listSessions(alice);
    const t = resolver.resolve({ session: sessions[0]!.ref }, alice, () => {});
    expect(t.pcCommand).toBeUndefined();
  });
});

describe("露出した値はストアの実体から切り離す", () => {
  it("allow 配列を書き換えてもストアの許可リストは変わらない（浅い複製にしない）", () => {
    const store = serverStore();
    store.addSession(
      { name: "d", system: "sys", sessionType: "display", pcCommand: { enabled: true, allow: ["echo .*"] } },
      admin
    );
    const listed = store.listSessions(admin, { includeTrusted: true });
    listed[0]!.pcCommand!.allow!.push(".*");
    expect(store.listSessions(admin, { includeTrusted: true })[0]?.pcCommand?.allow).toEqual(["echo .*"]);
  });
});
