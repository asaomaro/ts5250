import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WsConnection } from "../src/ws-handler.js";
import { SessionManager } from "../src/session-manager.js";
import { ProfileStore } from "../src/profiles.js";
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
  const profiles = new ProfileStore([{ name: "p", host: "h", signon: { user: "U", password: "P" } }]);
  const conn = new WsConnection({ sessions: mgr, profiles }, { send: (d) => sent.push(JSON.parse(d)), close: () => {} });
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
    const profiles = new ProfileStore([]);
    const conn = new WsConnection({ sessions: mgr, profiles }, { send: (d) => sent.push(JSON.parse(d)), close: () => {} });
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
