import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WsConnection } from "../src/ws-handler.js";
import { SessionManager } from "../src/session-manager.js";
import { ConfigResolver } from "../src/config-resolver.js";
import { PersonalConfigStore, ServerConfigStore } from "../src/config-store.js";
import { ReplayTransport, parseTraceJsonl, type Session5250, type Transport } from "@ts5250/tn5250";
import type { WsServerMessage } from "../src/ws-messages.js";

/**
 * **ブラウザの端末はホストに切られたら自動で繋ぎ直す**（`20260921-auto-reconnect`）。
 *
 * 繋ぎ直しそのものはコア（`Session5250` の `autoReconnect`。`packages/tn5250/test/auto-reconnect.test.ts`）。
 * ここではサーバーの配線を固定する——ブラウザから開いた接続で ON にする／経過をブラウザへ知らせる／
 * 繋ぎ直して変わった装置名（＝ジョブ名）を持ち越さない。
 */
const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(here, "..", "..", "tn5250", "test", "fixtures");
const signon = () => parseTraceJsonl(readFileSync(join(fixtureDir, "pub400-signon.jsonl"), "utf8"));

class InjectingManager extends SessionManager {
  readonly opened: Parameters<SessionManager["open"]>[0][] = [];
  constructor(private readonly makeTransport: () => Transport) {
    super();
  }
  override open(opts: Parameters<SessionManager["open"]>[0]) {
    this.opened.push(opts);
    return super.open({ ...opts, transport: this.makeTransport() });
  }
}
type Emitting = { emit(event: string, ...args: unknown[]): void };

async function openSession() {
  const sent: WsServerMessage[] = [];
  const mgr = new InjectingManager(() => new ReplayTransport(signon()));
  const resolver = new ConfigResolver(
    new ServerConfigStore({ systems: [{ id: "p", name: "p", host: "h" }], sessions: [] }),
    new PersonalConfigStore()
  );
  const conn = new WsConnection({ sessions: mgr, resolver }, { send: (d) => sent.push(JSON.parse(d)), close: () => {} });
  await conn.handle(JSON.stringify({ type: "open", host: "h" }));
  const sessionId = (sent[0] as { sessionId: string }).sessionId;
  const session: Session5250 = mgr.get(sessionId).session;
  sent.length = 0;
  const emit = (event: string, ...args: unknown[]) => (session as unknown as Emitting).emit(event, ...args);
  return { conn, mgr, sent, sessionId, session, emit };
}

describe("ホストへの自動再接続（サーバーの配線）", () => {
  it("**ブラウザから開いた接続は autoReconnect を ON にする**（ACS の画面の層と同じ）", async () => {
    const { mgr } = await openSession();
    expect(mgr.opened[0]!.autoReconnect).toBe(true);
    mgr.closeAll();
  });

  it("**繋ぎ直している経過をブラウザへ知らせ、施錠した画面も送る**", async () => {
    const { mgr, sent, session, emit } = await openSession();
    // 本物の繋ぎ直しと同じく、コアは reconnecting（施錠）になっている
    (session as unknown as { state: string }).state = "reconnecting";
    emit("reconnecting", { attempt: 2, reason: "socket closed" });
    expect(sent[0]).toEqual({ type: "host-reconnecting", attempt: 2, reason: "socket closed" });
    expect(sent[1]?.type).toBe("screen");
    expect((sent[1] as { screen: { keyboardLocked: boolean } }).screen.keyboardLocked, "解錠した画面を送った").toBe(true);
    mgr.closeAll();
  });

  it("**繋ぎ直したら知らせ、新しい装置名（ジョブ名）を持ち越さずに送る**", async () => {
    const { mgr, sent, sessionId, emit } = await openSession();
    emit("reconnected", { code: "I902", device: "NEWDEV01", system: "SYS" });
    expect(sent[0]).toEqual({ type: "host-reconnected" });
    expect(sent[1]).toEqual({ type: "jobinfo", job: { name: "NEWDEV01", system: "SYS" } });
    expect(mgr.get(sessionId).job?.name).toBe("NEWDEV01");
    mgr.closeAll();
  });

  it("購読を外したら、経過も終了も送らない（`closed` の購読も外す）", async () => {
    const { conn, sent, emit } = await openSession();
    // 転送断で外す（セッションは猶予で生きている）。`close` だとセッションごと終わって確かめられない
    conn.onSocketClose();
    sent.length = 0;
    emit("reconnecting", { attempt: 1, reason: "x" });
    emit("reconnected", undefined);
    emit("closed", "gone");
    expect(sent.filter((m) => m.type === "host-reconnecting" || m.type === "host-reconnected" || m.type === "closed")).toEqual([]);
  });

  it("**開き直したとき、繋ぎ直しの最中なら `opened` にその回数を載せる**", async () => {
    const { mgr, sessionId, session } = await openSession();
    (session as unknown as { state: string; reconnectAttempt: number }).state = "reconnecting";
    (session as unknown as { reconnectAttempt: number }).reconnectAttempt = 3;
    const sent2: WsServerMessage[] = [];
    const resolver = new ConfigResolver(
      new ServerConfigStore({ systems: [{ id: "p", name: "p", host: "h" }], sessions: [] }),
      new PersonalConfigStore()
    );
    const conn2 = new WsConnection({ sessions: mgr, resolver }, { send: (d) => sent2.push(JSON.parse(d)), close: () => {} });
    await conn2.handle(JSON.stringify({ type: "open", sessionId }));
    expect(sent2.find((m) => m.type === "opened")).toMatchObject({ hostReconnect: { attempt: 3 } });
    (session as unknown as { state: string }).state = "ready";
    mgr.closeAll();
  });

  it("**自動操作が予約している間にホストに切られたら、繋ぎ直さずに終える**", async () => {
    const { mgr, sent, sessionId, session, emit } = await openSession();
    mgr.reserve(sessionId, "agent-1", "agent");
    let ended = false;
    session.on("closed", () => (ended = true));
    (session as unknown as { state: string }).state = "reconnecting";
    emit("reconnecting", { attempt: 1, reason: "socket closed" });
    await new Promise((r) => setTimeout(r, 10));
    expect(ended, "予約中なのに繋ぎ直しを続けた").toBe(true);
    expect(sent.some((m) => m.type === "closed")).toBe(true);
    mgr.closeAll();
  });
});
