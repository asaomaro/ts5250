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
import { ReplayTransport, parseTraceJsonl, type Transport } from "@ts5250/tn5250";
import type { WsServerMessage } from "../src/ws-messages.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(here, "..", "..", "tn5250", "test", "fixtures");
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

/**
 * **予約中はブラウザから打てない。**
 *
 * この検査が要る理由: 締め出しは `SessionManager.assertKeyAllowed` の内側に置いてあり、
 * ws-handler には予約を見るコードが 1 行も無い。**構造で効いていること**を経路側から確かめる。
 */
describe("WsConnection: 予約中の締め出し", () => {
  const open = async (): Promise<ReturnType<typeof setup> & { id: string }> => {
    const s = setup();
    await s.conn.handle(JSON.stringify({ type: "open", host: "h" }));
    const opened = s.sent[0] as { sessionId: string };
    s.sent.length = 0;
    return { ...s, id: opened.sessionId };
  };

  it("**予約中の key は SESSION_RESERVED**（打ちかけが別の画面へ載るのを防ぐ）", async () => {
    const { conn, sent, mgr, id } = await open();
    mgr.reserve(id, "auto", "HLLAPI");
    sent.length = 0;
    await conn.handle(JSON.stringify({ type: "key", key: "Enter" }));
    expect(sent[0]).toMatchObject({ type: "error", code: "SESSION_RESERVED" });
    mgr.closeAll();
  });

  it("**予約の開始・解除が push される**（画面を変えずに起きるので別メッセージ）", async () => {
    const { sent, mgr, id } = await open();
    mgr.reserve(id, "auto", "HLLAPI");
    mgr.release(id, "auto");
    expect(sent.filter((m) => m.type === "reserved")).toEqual([
      { type: "reserved", by: "HLLAPI" },
      { type: "reserved" }
    ]);
    mgr.closeAll();
  });

  it("**利用者は強制解除できる**（自動化が落ちて Release が来ないときの非常口）", async () => {
    const { conn, mgr, id } = await open();
    mgr.reserve(id, "auto", "HLLAPI");
    await conn.handle(JSON.stringify({ type: "reserve-break" }));
    expect(mgr.reservationOf(id)).toBeUndefined();
    mgr.closeAll();
  });

  // 「解除後はまた打てる」は**ここでは検査しない**——Enter がホストの応答を待って
  // 5 秒止まる（ReplayTransport に続きが無い）。解除の意味は session-manager.test.ts が持つ
});
