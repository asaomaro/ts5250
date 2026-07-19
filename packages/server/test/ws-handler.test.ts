import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { WsConnection } from "../src/ws-handler.js";
import { SessionManager } from "../src/session-manager.js";
import { ConfigResolver } from "../src/config-resolver.js";
import { PersonalConfigStore, ServerConfigStore } from "../src/config-store.js";
import { parseRef } from "../src/config-types.js";
import { SecretCrypto } from "../src/secret-crypto.js";
import type { AuthUser } from "../src/auth.js";
import { ReplayTransport, parseTraceJsonl, type Transport } from "@as400web/core";
import type { WsServerMessage } from "../src/ws-messages.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(here, "..", "..", "core", "test", "fixtures");
const signon = () => parseTraceJsonl(readFileSync(join(fixtureDir, "pub400-signon.jsonl"), "utf8"));

/** SessionManager が transport を注入できるよう、open のたびに新しい ReplayTransport を返すよう細工した Manager */
class InjectingManager extends SessionManager {
  constructor(private readonly makeTransport: () => Transport) {
    super();
  }
  override open(opts: Parameters<SessionManager["open"]>[0]) {
    return super.open({ ...opts, transport: this.makeTransport() });
  }
}

function setup(readOnly = false) {
  const sent: WsServerMessage[] = [];
  const mgr = new InjectingManager(() => new ReplayTransport(signon()));
  const server = new ServerConfigStore({
    systems: [{ id: "p", name: "p", host: "h" }],
    sessions: []
  });
  const resolver = new ConfigResolver(server, new PersonalConfigStore());
  const conn = new WsConnection({ sessions: mgr, resolver }, { send: (d) => sent.push(JSON.parse(d)), close: () => {} });
  return { conn, sent, mgr, readOnly };
}

describe("WsConnection", () => {
  it("open で opened＋初期画面を返す", async () => {
    const { conn, sent } = setup();
    await conn.handle(JSON.stringify({ type: "open", host: "h" }));
    expect(sent[0]?.type).toBe("opened");
    const opened = sent[0] as { type: "opened"; sessionId: string; screen: { fields: unknown[] } };
    expect(opened.sessionId).toBeTruthy();
    expect(opened.screen.fields.length).toBeGreaterThan(0);
  });

  it("open 前の key は SESSION_NOT_FOUND エラー", async () => {
    const { conn, sent } = setup();
    await conn.handle(JSON.stringify({ type: "key", key: "Enter" }));
    expect(sent[0]).toMatchObject({ type: "error", code: "SESSION_NOT_FOUND" });
  });

  it("不正な JSON は error を返す", async () => {
    const { conn, sent } = setup();
    await conn.handle("{ not json");
    expect(sent[0]).toMatchObject({ type: "error", code: "PROTOCOL_ERROR" });
  });

  it("readOnly セッションの key(Enter) は READ_ONLY_SESSION", async () => {
    const sent: WsServerMessage[] = [];
    const mgr = new InjectingManager(() => new ReplayTransport(signon()));
    const resolver = new ConfigResolver(new ServerConfigStore(), new PersonalConfigStore());
    const conn = new WsConnection({ sessions: mgr, resolver }, { send: (d) => sent.push(JSON.parse(d)), close: () => {} });
    await conn.handle(JSON.stringify({ type: "open", host: "h", readOnly: true }));
    await conn.handle(JSON.stringify({ type: "key", key: "Enter" }));
    expect(sent.find((m) => m.type === "error")).toMatchObject({ code: "READ_ONLY_SESSION" });
  });

  it("close でセッションが破棄され closed を返す", async () => {
    const { conn, sent, mgr } = setup();
    await conn.handle(JSON.stringify({ type: "open", host: "h" }));
    expect(mgr.size).toBe(1);
    await conn.handle(JSON.stringify({ type: "close" }));
    expect(sent.some((m) => m.type === "closed")).toBe(true);
    expect(mgr.size).toBe(0);
  });

  it("onSocketClose でセッションが破棄される", async () => {
    const { conn, mgr } = setup();
    await conn.handle(JSON.stringify({ type: "open", host: "h" }));
    expect(mgr.size).toBe(1);
    conn.onSocketClose();
    expect(mgr.size).toBe(0);
  });
});

describe("WsConnection: 保存済み接続の ID 参照 open", () => {
  const crypto = SecretCrypto.fromEnv("K", { K: randomBytes(32).toString("hex") })!;
  const alice: AuthUser = { username: "alice", role: "user" };
  const bob: AuthUser = { username: "bob", role: "user" };

  function setupConn(user: AuthUser) {
    const sent: WsServerMessage[] = [];
    const mgr = new InjectingManager(() => new ReplayTransport(signon()));
    const personal = new PersonalConfigStore({ systems: [], sessions: [] }, crypto);
    const system = personal.addSystem({ name: "pub400", host: "pub400.com" }, alice);
    const session = personal.addSession(
      { name: "pub400", system: parseRef(system.ref)!.id, sessionType: "display" },
      alice
    );
    const conn = new WsConnection(
      { sessions: mgr, resolver: new ConfigResolver(new ServerConfigStore(), personal) },
      { send: (d) => sent.push(JSON.parse(d)), close: () => {} },
      user
    );
    return { conn, sent, ref: session.ref };
  }

  it("owner 本人は session 参照で開ける", async () => {
    const { conn, sent, ref } = setupConn(alice);
    await conn.handle(JSON.stringify({ type: "open", session: ref }));
    expect(sent[0]?.type).toBe("opened");
  });

  it("他人の session 参照は FORBIDDEN", async () => {
    const { conn, sent, ref } = setupConn(bob);
    await conn.handle(JSON.stringify({ type: "open", session: ref }));
    expect(sent.find((m) => m.type === "error")).toMatchObject({ code: "FORBIDDEN" });
  });

  it("個人設定ストア未配線での参照は CONFIG_ERROR", async () => {
    const sent: WsServerMessage[] = [];
    const mgr = new InjectingManager(() => new ReplayTransport(signon()));
    const conn = new WsConnection(
      { sessions: mgr, resolver: new ConfigResolver(new ServerConfigStore(), undefined) },
      { send: (d) => sent.push(JSON.parse(d)), close: () => {} }
    );
    await conn.handle(JSON.stringify({ type: "open", session: "own:c-x" }));
    expect(sent.find((m) => m.type === "error")).toMatchObject({ code: "CONFIG_ERROR" });
  });
});
