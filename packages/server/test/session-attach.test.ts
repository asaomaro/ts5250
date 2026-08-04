import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WsConnection } from "../src/ws-handler.js";
import { SessionManager } from "../src/session-manager.js";
import { ConfigResolver } from "../src/config-resolver.js";
import { PersonalConfigStore, ServerConfigStore } from "../src/config-store.js";
import { ReplayTransport, parseTraceJsonl, type Transport } from "@ts5250/tn5250";
import type { WsServerMessage } from "../src/ws-messages.js";
import type { AuthUser } from "../src/auth.js";

/**
 * **既存のセッションをブラウザから開く（attach）。**
 *
 * MCP や HLLAPI が開いた画面を、あとから人が見られるようにする。
 * 要点は**同じセッションを 2 つの接続が見られること**——以前は通知が単数枠で、
 * 2 つ目が繋いだ時点で 1 つ目の予約通知が止まり、どちらか閉じると残った方も消えた。
 */
const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(here, "..", "..", "tn5250", "test", "fixtures");
const signon = () => parseTraceJsonl(readFileSync(join(fixtureDir, "pub400-signon.jsonl"), "utf8"));

class InjectingManager extends SessionManager {
  constructor(private readonly makeTransport: () => Transport) {
    super();
  }
  override open(opts: Parameters<SessionManager["open"]>[0]) {
    return super.open({ ...opts, transport: this.makeTransport() });
  }
}

function conn(mgr: SessionManager, user?: AuthUser) {
  const sent: WsServerMessage[] = [];
  const resolver = new ConfigResolver(
    new ServerConfigStore({ systems: [{ id: "p", name: "p", host: "h" }], sessions: [] }),
    new PersonalConfigStore()
  );
  const c = new WsConnection(
    { sessions: mgr, resolver },
    { send: (d) => sent.push(JSON.parse(d)), close: () => {} },
    user
  );
  return { c, sent };
}

const openNew = async (mgr: SessionManager) => {
  const { c, sent } = conn(mgr);
  await c.handle(JSON.stringify({ type: "open", host: "h" }));
  return { c, sent, id: (sent[0] as { sessionId: string }).sessionId };
};

describe("既存セッションへの attach", () => {
  it("**開いているセッションへ繋げる**（新規に開かない）", async () => {
    const mgr = new InjectingManager(() => new ReplayTransport(signon()));
    const first = await openNew(mgr);
    expect(mgr.size).toBe(1);

    const second = conn(mgr);
    await second.c.handle(JSON.stringify({ type: "open", sessionId: first.id }));
    expect(second.sent[0]).toMatchObject({ type: "opened", sessionId: first.id });
    // **新しい接続を作っていない**
    expect(mgr.size).toBe(1);
    mgr.closeAll();
  });

  it("**2 つの接続が同じ画面を見られる**（在席も 2）", async () => {
    const mgr = new InjectingManager(() => new ReplayTransport(signon()));
    const first = await openNew(mgr);
    const second = conn(mgr);
    await second.c.handle(JSON.stringify({ type: "open", sessionId: first.id }));
    expect(mgr.get(first.id).viewers).toBe(2);
    mgr.closeAll();
  });

  it("**予約の通知が両方へ届く**（単数枠だと 2 つ目が 1 つ目を消していた）", async () => {
    const mgr = new InjectingManager(() => new ReplayTransport(signon()));
    const first = await openNew(mgr);
    const second = conn(mgr);
    await second.c.handle(JSON.stringify({ type: "open", sessionId: first.id }));
    first.sent.length = 0;
    second.sent.length = 0;

    mgr.reserve(first.id, "auto", "MCP");
    expect(first.sent).toContainEqual({ type: "reserved", by: "MCP" });
    expect(second.sent).toContainEqual({ type: "reserved", by: "MCP" });
    mgr.closeAll();
  });

  it("**片方を閉じても、もう片方の通知は生きている**", async () => {
    const mgr = new InjectingManager(() => new ReplayTransport(signon()));
    const first = await openNew(mgr);
    const second = conn(mgr);
    await second.c.handle(JSON.stringify({ type: "open", sessionId: first.id }));

    second.c.onSocketClose();
    expect(mgr.get(first.id).viewers).toBe(1);

    first.sent.length = 0;
    mgr.reserve(first.id, "auto", "MCP");
    expect(first.sent).toContainEqual({ type: "reserved", by: "MCP" });
    mgr.closeAll();
  });

  it("**繋いだだけのタブは、閉じてもセッションを殺さない**", async () => {
    const mgr = new InjectingManager(() => new ReplayTransport(signon()));
    // MCP が開いたつもりのセッション（誰も見ていない）
    const entry = await mgr.open({ host: "h" });
    const viewer = conn(mgr);
    await viewer.c.handle(JSON.stringify({ type: "open", sessionId: entry.id }));
    viewer.c.onSocketClose();
    // **見に来た人が去っただけで、相手の作業を殺さない**
    expect(mgr.get(entry.id).viewers).toBe(0);
    expect(mgr.size).toBe(1);
    mgr.closeAll();
  });

  it("**自分が開いたタブでも、他に見ている人が残っていれば閉じない**", async () => {
    const mgr = new InjectingManager(() => new ReplayTransport(signon()));
    const first = await openNew(mgr);
    const second = conn(mgr);
    await second.c.handle(JSON.stringify({ type: "open", sessionId: first.id }));
    first.c.onSocketClose();
    expect(mgr.size).toBe(1);
    expect(mgr.get(first.id).viewers).toBe(1);
    mgr.closeAll();
  });

  it("最後の 1 つが閉じればセッションも閉じる（従来どおり）", async () => {
    const mgr = new InjectingManager(() => new ReplayTransport(signon()));
    const first = await openNew(mgr);
    first.c.onSocketClose();
    await new Promise((r) => setTimeout(r, 20));
    expect(mgr.size).toBe(0);
  });

  it("**他人のセッションは開けない**", async () => {
    const mgr = new InjectingManager(() => new ReplayTransport(signon()));
    const entry = await mgr.open({ host: "h", owner: "tanaka" });
    const other = conn(mgr, { username: "suzuki", role: "user" } as AuthUser);
    await other.c.handle(JSON.stringify({ type: "open", sessionId: entry.id }));
    expect(other.sent[0]).toMatchObject({ type: "error", code: "FORBIDDEN" });
    mgr.closeAll();
  });

  it("**無い id は SESSION_NOT_FOUND**", async () => {
    const mgr = new InjectingManager(() => new ReplayTransport(signon()));
    const { c, sent } = conn(mgr);
    await c.handle(JSON.stringify({ type: "open", sessionId: "no-such" }));
    expect(sent[0]).toMatchObject({ type: "error", code: "SESSION_NOT_FOUND" });
    mgr.closeAll();
  });

  it("**予約中の attach では、いまの状態が伝わる**（後から入っても揃う）", async () => {
    const mgr = new InjectingManager(() => new ReplayTransport(signon()));
    const first = await openNew(mgr);
    mgr.reserve(first.id, "auto", "MCP");

    const second = conn(mgr);
    await second.c.handle(JSON.stringify({ type: "open", sessionId: first.id }));
    expect(second.sent[0]).toMatchObject({ type: "opened", reservedBy: "MCP" });
    mgr.closeAll();
  });
});

describe("購読の解除", () => {
  it("**自分の分だけ外れる**（他の購読者を消さない）", async () => {
    const mgr = new InjectingManager(() => new ReplayTransport(signon()));
    const entry = await mgr.open({ host: "h" });
    const a: string[] = [];
    const b: string[] = [];
    const offA = mgr.subscribeReservation(entry.id, (r) => a.push(r?.label ?? "-"));
    mgr.subscribeReservation(entry.id, (r) => b.push(r?.label ?? "-"));

    offA();
    mgr.reserve(entry.id, "x", "HLLAPI");
    expect(a).toEqual([]);
    expect(b).toEqual(["HLLAPI"]);
    mgr.closeAll();
  });

  it("**閉じた接続へ送らない**（購読が残るとリークする）", async () => {
    const mgr = new InjectingManager(() => new ReplayTransport(signon()));
    // MCP が開いたつもりのセッションへ繋いで、離れる
    const entry = await mgr.open({ host: "h" });
    const viewer = conn(mgr);
    await viewer.c.handle(JSON.stringify({ type: "open", sessionId: entry.id }));
    viewer.c.onSocketClose();
    viewer.sent.length = 0;

    // セッションは生きている（繋いだだけのタブは殺さない）が、**通知は来ない**
    mgr.reserve(entry.id, "auto", "MCP");
    expect(viewer.sent).toEqual([]);
    mgr.closeAll();
  });
});
