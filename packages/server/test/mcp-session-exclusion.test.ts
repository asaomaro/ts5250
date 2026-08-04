import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../src/mcp-server.js";
import { SessionManager, type SessionEntry } from "../src/session-manager.js";
import { ServerConfigStore, PersonalConfigStore } from "../src/config-store.js";
import { ConfigResolver } from "../src/config-resolver.js";
import { MCP_RESERVATION_TTL_MS } from "../src/mcp-tools.js";
import type { AuthUser } from "../src/auth.js";
import type { ScreenSnapshot, Cell, Session5250 } from "@ts5250/tn5250";

/**
 * **MCP は、見ている人が居るときだけ排他する。**
 *
 * 5250 は入力欄の値を AID と一緒に送るので、ブラウザは Enter を押すまで打ちかけを手元に持つ。
 * その最中に MCP が画面を変えると、打ちかけの行き先が消える。
 *
 * ただし**誰も見ていなければ予約しない**——締め出す相手が居ないので儀式でしかない
 * （MCP が自分で開いたセッションが典型）。
 */

const SID = "sess-1";

const cell = (): Cell => ({
  char: " ",
  kind: "sbcs",
  color: "green",
  reverse: false,
  underline: false,
  blink: false,
  columnSeparator: false,
  nonDisplay: false
});

function snapshot(): ScreenSnapshot {
  const cells: Cell[][] = [];
  for (let r = 0; r < 24; r++) cells.push(Array.from({ length: 80 }, () => cell()));
  return {
    sessionId: SID,
    rows: 24,
    cols: 80,
    cursor: { row: 1, col: 1 },
    keyboardLocked: false,
    cells,
    fields: []
  } as ScreenSnapshot;
}

interface Harness {
  mgr: SessionManager;
  client: Client;
  tick: (ms: number) => void;
}

async function setup(opts: { viewers?: number; owner?: string; user?: AuthUser } = {}): Promise<Harness> {
  let t = 1000;
  const mgr = new SessionManager({ now: () => t });
  const entry = {
    id: SID,
    session: {
      snapshot: () => snapshot(),
      sendAid: async () => ({ screen: snapshot(), timedOut: false }),
      setField: () => undefined,
      disconnect: () => undefined,
      keyboardLocked: false
    } as unknown as Session5250,
    readOnly: false,
    host: "h",
    origin: "test",
    viewers: 0,
    connectedAt: new Date(0).toISOString(),
    lastActivity: 0,
    ...(opts.owner !== undefined ? { owner: opts.owner } : {})
  } satisfies SessionEntry;
  (mgr as unknown as { sessions: Map<string, SessionEntry> }).sessions.set(SID, entry);
  for (let i = 0; i < (opts.viewers ?? 0); i++) mgr.addViewer(SID);

  const server = buildMcpServer({
    sessions: mgr,
    resolver: new ConfigResolver(
      new ServerConfigStore({ systems: [], sessions: [] }),
      new PersonalConfigStore({ systems: [], sessions: [] })
    ),
    version: "test",
    ...(opts.user ? { user: opts.user } : {})
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" }, { capabilities: {} });
  await Promise.all([server.connect(b), client.connect(a)]);
  await client.listTools();
  return { mgr, client, tick: (ms) => (t += ms) };
}

const sendKey = (h: Harness) =>
  h.client.callTool({ name: "send_key", arguments: { sessionId: SID, key: "Enter" } });

describe("MCP の排他", () => {
  it("**見ている人が居れば予約する**（画面に「MCP が自動操作中です」が出る）", async () => {
    const h = await setup({ viewers: 1 });
    await sendKey(h);
    expect(h.mgr.reservationOf(SID)?.label).toBe("MCP");
    h.mgr.closeAll();
  });

  it("**誰も見ていなければ予約しない**（MCP が自分で開いた場合。儀式にしない）", async () => {
    const h = await setup({ viewers: 0 });
    await sendKey(h);
    expect(h.mgr.reservationOf(SID)).toBeUndefined();
    h.mgr.closeAll();
  });

  it("**予約中もブラウザは締め出される**（holder を渡さない＝人間）", async () => {
    const h = await setup({ viewers: 1 });
    await sendKey(h);
    expect(() => h.mgr.assertKeyAllowed(SID, "Enter")).toThrowError();
    h.mgr.closeAll();
  });

  it("**連射しても取り直しにならない**（覆いが点滅しない）", async () => {
    const h = await setup({ viewers: 1 });
    await sendKey(h);
    const first = h.mgr.reservationOf(SID);
    h.tick(MCP_RESERVATION_TTL_MS - 1);
    await sendKey(h);
    const second = h.mgr.reservationOf(SID);
    // 同じ持ち主のまま期限だけ延びている（解除→再取得ではない）
    expect(second?.holder).toBe(first?.holder);
    expect(second!.expiresAt).toBeGreaterThan(first!.expiresAt);
    h.mgr.closeAll();
  });

  it("**終われば自然に解ける**（短い期限）", async () => {
    const h = await setup({ viewers: 1 });
    await sendKey(h);
    h.tick(MCP_RESERVATION_TTL_MS + 1);
    expect(h.mgr.reservationOf(SID)).toBeUndefined();
    h.mgr.closeAll();
  });

  it("**期限は HLLAPI より短い**（道具が勝手に取るので、すぐ手放す）", async () => {
    const h = await setup({ viewers: 1 });
    await sendKey(h);
    expect(h.mgr.reservationOf(SID)!.ttlMs).toBe(MCP_RESERVATION_TTL_MS);
    expect(MCP_RESERVATION_TTL_MS).toBeLessThan(120_000);
    h.mgr.closeAll();
  });

  it("**他の自動化が持っていれば書かずに断る**（割り込んで画面を半端にしない）", async () => {
    const h = await setup({ viewers: 1 });
    h.mgr.reserve(SID, "hllapi:", "HLLAPI");
    const r = (await sendKey(h)) as { content: { text: string }[] };
    expect(r.content[0]!.text).toContain("SESSION_RESERVED");
    // HLLAPI の予約は奪われていない
    expect(h.mgr.reservationOf(SID)?.label).toBe("HLLAPI");
    h.mgr.closeAll();
  });

  it("**他人のセッションなら操作者の名前が出る**", async () => {
    const admin = { username: "kanri", role: "admin" } as AuthUser;
    const h = await setup({ viewers: 1, owner: "tanaka", user: admin });
    await sendKey(h);
    expect(h.mgr.reservationOf(SID)?.label).toBe("kanri（MCP）");
    h.mgr.closeAll();
  });

  /**
   * **遅延評価では足りない。** `reservationOf` は読まれたときに刈るが、誰も読まなければ
   * ブラウザへ解除が通知されない——サーバーは通す状態なのに画面には覆いが出たまま、
   * 人が締め出される。**実機の E2E で踏んだ**（30 秒待っても消えなかった）。
   */
  it("**誰も読まなくても、期限が来たら解除が通知される**", async () => {
    // ここは実時間で見る（タイマーが本当に動くことを確かめたいので偽の時計を使わない）
    const mgr = new SessionManager();
    const entry = {
      id: SID,
      session: { snapshot: () => snapshot(), disconnect: () => undefined } as unknown as Session5250,
      readOnly: false, host: "h", origin: "test", viewers: 1,
      connectedAt: new Date(0).toISOString(), lastActivity: 0
    } satisfies SessionEntry;
    (mgr as unknown as { sessions: Map<string, SessionEntry> }).sessions.set(SID, entry);

    const seen: (string | undefined)[] = [];
    mgr.subscribeReservation(SID, (r) => seen.push(r?.label));
    mgr.reserve(SID, "mcp:", "MCP", undefined, 40);
    await new Promise((r) => setTimeout(r, 120));
    // **誰も reservationOf を呼んでいない**のに解除が届いている
    expect(seen).toEqual(["MCP", undefined]);
    mgr.closeAll();
  });

  it("**`list_sessions` で予約中だと分かる**（断られて初めて気づく、を避ける）", async () => {
    const h = await setup({ viewers: 1 });
    await sendKey(h);
    const r = (await h.client.callTool({ name: "list_sessions", arguments: {} })) as {
      structuredContent: { sessions: { reservedBy?: string }[] };
    };
    expect(r.structuredContent.sessions[0]?.reservedBy).toBe("MCP");
    h.mgr.closeAll();
  });
});
