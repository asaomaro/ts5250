import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../src/mcp-server.js";
import { SessionManager } from "../src/session-manager.js";
import { ProfileStore } from "../src/profiles.js";
import { ConnectionStore } from "../src/connection-store.js";
import type { AuthUser } from "../src/auth.js";

/**
 * MCP クライアントは接続設定を探索する手段が無く、profile 名や connection ID を人間が
 * 事前に知っている必要があった。list_connections はその穴を埋める。
 * 可視範囲は既存の認可規則（profiles=admin 限定 / connections=所有者スコープ）を再利用する。
 */
type Entry = {
  kind: "profile" | "connection";
  ref: string;
  name: string;
  host: string;
  sessionType: "display" | "printer";
  autoSignon: boolean;
};

function profilesFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "lc-"));
  const path = join(dir, "profiles.json");
  writeFileSync(
    path,
    JSON.stringify({
      profiles: [
        {
          name: "srv",
          host: "h1",
          sessionType: "printer",
          signon: { user: "USER", passwordEnv: "PW" },
          printer: { autoPdfDir: "/var/spool/out", autoPrint: "Office" }
        }
      ]
    })
  );
  return path;
}

async function list(user?: AuthUser, connStore?: ConnectionStore): Promise<{ entries: Entry[]; text: string }> {
  const server = buildMcpServer({
    sessions: new SessionManager(),
    profiles: ProfileStore.fromFile(profilesFile()),
    ...(connStore ? { connections: connStore } : {}),
    version: "test",
    ...(user ? { user } : {})
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" }, { capabilities: {} });
  await Promise.all([server.connect(b), client.connect(a)]);
  const r = (await client.callTool({ name: "list_connections", arguments: {} })) as {
    structuredContent: { connections: Entry[] };
    content: { text: string }[];
  };
  await client.close();
  return { entries: r.structuredContent.connections, text: r.content[0]!.text };
}

function connStore(owner?: string): ConnectionStore {
  const path = join(mkdtempSync(join(tmpdir(), "lc-c-")), "connections.json");
  writeFileSync(path, JSON.stringify({ connections: [] }));
  const s = ConnectionStore.fromFile(path);
  s.add({ name: "mine", host: "h2", sessionType: "display" }, owner ? { username: owner, role: "user" } : undefined);
  return s;
}

describe("list_connections（MCP からの接続設定の探索）", () => {
  it("認証オフではサーバー設定と保存済み接続の両方を返す", async () => {
    const { entries } = await list(undefined, connStore());
    expect(entries.map((e) => e.kind).sort()).toEqual(["connection", "profile"]);
  });

  it("open_session に渡す参照方法を示す（profile は name / connection は id）", async () => {
    const { entries } = await list(undefined, connStore());
    const p = entries.find((e) => e.kind === "profile")!;
    expect(p.ref).toBe("srv");
    const c = entries.find((e) => e.kind === "connection")!;
    expect(c.ref).not.toBe(c.name); // 生成 ID であって名前ではない
    expect(c.ref.length).toBeGreaterThan(0);
  });

  it("一般ユーザーにはサーバー設定を返さない（admin 限定の規則を再利用）", async () => {
    const { entries } = await list({ username: "alice", role: "user" });
    expect(entries.filter((e) => e.kind === "profile")).toEqual([]);
  });

  it("admin にはサーバー設定を返す", async () => {
    const { entries } = await list({ username: "root", role: "admin" });
    expect(entries.some((e) => e.kind === "profile" && e.ref === "srv")).toBe(true);
  });

  it("一般ユーザーには自分の接続だけが返る", async () => {
    const alice: AuthUser = { username: "alice", role: "user" };
    const mine = await list(alice, connStore("alice"));
    expect(mine.entries.map((e) => e.ref)).toHaveLength(1);
    const others = await list(alice, connStore("bob"));
    expect(others.entries).toEqual([]);
  });

  it("信頼設定と資格情報を返さない（LLM のコンテキストに残さない）", async () => {
    const { entries } = await list();
    const keys = new Set(entries.flatMap((e) => Object.keys(e)));
    expect(keys.has("printer")).toBe(false);
    expect(keys.has("signonUser")).toBe(false);
    const dump = JSON.stringify(entries);
    expect(dump).not.toContain("autoPdfDir");
    expect(dump).not.toContain("/var/spool/out");
    expect(dump).not.toContain("Office");
    expect(dump).not.toContain("USER");
    // 自動サインオンの有無は真偽値でのみ示す
    expect(entries.find((e) => e.kind === "profile")!.autoSignon).toBe(true);
  });

  it("何も無ければその旨をテキストで返す", async () => {
    const { entries, text } = await list({ username: "alice", role: "user" });
    expect(entries).toEqual([]);
    expect(text).toContain("ありません");
  });
});
