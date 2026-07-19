import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../src/mcp-server.js";
import { SessionManager } from "../src/session-manager.js";
import { ServerConfigStore, PersonalConfigStore } from "../src/config-store.js";
import { ConfigResolver } from "../src/config-resolver.js";
import type { AuthUser } from "../src/auth.js";

/**
 * MCP クライアントは接続設定を探索する手段が無いので、一覧ツールがその穴を埋める。
 * 可視範囲は既存の認可規則（サーバー設定=admin 限定 / 個人設定=所有者スコープ）を再利用する。
 *
 * **この一覧が資格情報と信頼設定を返さないこと**が、旧 `list_connections` から引き継ぐ最重要の不変条件。
 * システムは資格情報の集約点になるため、ここが緩むと一発で漏れる。
 */
const alice: AuthUser = { username: "alice", role: "user" };
const admin: AuthUser = { username: "root", role: "admin" };

interface SystemEntry {
  ref: string;
  name: string;
  host: string;
  autoSignon: boolean;
}
interface SessionEntry {
  ref: string;
  name: string;
  system: string;
  sessionType: "display" | "printer";
  deviceName?: string;
}

/** サーバー設定: 資格情報と printer 出力（信頼設定）を両方持つ */
function serverStore(): ServerConfigStore {
  const dir = mkdtempSync(join(tmpdir(), "mcpcfg-"));
  const path = join(dir, "profiles.json");
  writeFileSync(
    path,
    JSON.stringify({
      profiles: [
        {
          name: "srv",
          host: "h1",
          sessionType: "printer",
          deviceName: "PRT_SRV",
          signon: { user: "USER", passwordEnv: "PW" },
          printer: { autoPdfDir: "/var/spool/out", autoPrint: "Office" }
        }
      ]
    })
  );
  return ServerConfigStore.fromFile(path);
}

function personalStore(): PersonalConfigStore {
  return new PersonalConfigStore({
    systems: [{ id: "s-1", name: "alice の機", host: "h2", owner: "alice" }],
    sessions: [
      {
        id: "c-1",
        name: "alice のセッション",
        system: "s-1",
        sessionType: "display",
        deviceName: "MYDEV",
        owner: "alice"
      }
    ]
  });
}

async function callTool(
  name: string,
  user?: AuthUser
): Promise<{ structured: Record<string, unknown>; text: string; json: string }> {
  const server = buildMcpServer({
    sessions: new SessionManager(),
    resolver: new ConfigResolver(serverStore(), personalStore()),
    version: "test",
    ...(user ? { user } : {})
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" }, { capabilities: {} });
  await Promise.all([server.connect(b), client.connect(a)]);
  const r = (await client.callTool({ name, arguments: {} })) as {
    structuredContent: Record<string, unknown>;
    content: { text: string }[];
  };
  return {
    structured: r.structuredContent,
    text: r.content[0]?.text ?? "",
    json: JSON.stringify(r)
  };
}

describe("list_systems: 可視範囲", () => {
  it("認証オフでは両方の保管場所が見える", async () => {
    const { structured } = await callTool("list_systems");
    const systems = structured.systems as SystemEntry[];
    expect(systems.map((s) => s.ref).sort()).toEqual(["own:s-1", "srv:h1"]);
  });

  it("admin にはサーバー設定も見える", async () => {
    const { structured } = await callTool("list_systems", admin);
    const systems = structured.systems as SystemEntry[];
    expect(systems.some((s) => s.ref.startsWith("srv:"))).toBe(true);
  });

  it("一般ユーザーにはサーバー設定が見えない（admin 専用）", async () => {
    const { structured } = await callTool("list_systems", alice);
    const systems = structured.systems as SystemEntry[];
    expect(systems.every((s) => s.ref.startsWith("own:"))).toBe(true);
  });

  it("参照は接頭辞つきで、そのまま open_session の system に渡せる", async () => {
    const { structured } = await callTool("list_systems", admin);
    const systems = structured.systems as SystemEntry[];
    for (const s of systems) expect(s.ref).toMatch(/^(srv|own):/);
  });

  it("自動サインオンの有無は真偽値で分かる", async () => {
    const { structured } = await callTool("list_systems", admin);
    const srv = (structured.systems as SystemEntry[]).find((s) => s.ref === "srv:h1")!;
    expect(srv.autoSignon).toBe(true);
  });
});

describe("list_systems: 資格情報と信頼設定を返さない（最重要の不変条件）", () => {
  it("signon の user 名を返さない", async () => {
    const { json } = await callTool("list_systems", admin);
    expect(json).not.toContain("USER");
    expect(json).not.toContain("signonUser");
    expect(json).not.toContain("signon");
  });

  it("パスワード機構（passwordEnv / passwordEnc）を返さない", async () => {
    const { json } = await callTool("list_systems", admin);
    expect(json).not.toContain("passwordEnv");
    expect(json).not.toContain("passwordEnc");
    expect(json).not.toContain("PW");
  });

  it("printer 出力（信頼設定）を返さない", async () => {
    const { json } = await callTool("list_systems", admin);
    expect(json).not.toContain("autoPdfDir");
    expect(json).not.toContain("/var/spool/out");
    expect(json).not.toContain("Office");
  });
});

describe("list_session_configs", () => {
  it("セッション設定を親システムの参照つきで返す", async () => {
    const { structured } = await callTool("list_session_configs", admin);
    const sessions = structured.sessions as SessionEntry[];
    const srv = sessions.find((s) => s.ref === "srv:srv")!;
    expect(srv).toMatchObject({ system: "srv:h1", sessionType: "printer", deviceName: "PRT_SRV" });
  });

  it("printer 出力（信頼設定）を返さない", async () => {
    const { json } = await callTool("list_session_configs", admin);
    expect(json).not.toContain("autoPdfDir");
    expect(json).not.toContain("/var/spool/out");
    expect(json).not.toContain("Office");
  });

  it("一般ユーザーには自分のセッション設定だけが見える", async () => {
    const { structured } = await callTool("list_session_configs", alice);
    const sessions = structured.sessions as SessionEntry[];
    expect(sessions.map((s) => s.ref)).toEqual(["own:c-1"]);
  });

  it("空なら空である旨を返す", async () => {
    const server = buildMcpServer({
      sessions: new SessionManager(),
      resolver: new ConfigResolver(
        new ServerConfigStore({ systems: [], sessions: [] }),
        new PersonalConfigStore({ systems: [], sessions: [] })
      ),
      version: "test"
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "1" }, { capabilities: {} });
    await Promise.all([server.connect(b), client.connect(a)]);
    const r = (await client.callTool({
      name: "list_session_configs",
      arguments: {}
    })) as { content: { text: string }[] };
    expect(r.content[0]?.text).toContain("ありません");
  });
});

describe("ツールの引数に認証情報を取らない（D13）", () => {
  it("接続設定に関わるツールの引数に user / password が無い", async () => {
    const server = buildMcpServer({
      sessions: new SessionManager(),
      resolver: new ConfigResolver(serverStore(), personalStore()),
      version: "test"
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "1" }, { capabilities: {} });
    await Promise.all([server.connect(b), client.connect(a)]);
    const { tools } = await client.listTools();
    for (const name of ["open_session", "open_printer_session", "signon"]) {
      const tool = tools.find((t) => t.name === name)!;
      const props = Object.keys(
        (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}
      );
      expect(props, `${name} の引数`).not.toContain("password");
      expect(props, `${name} の引数`).not.toContain("user");
    }
  });

  it("接続設定は system / session で指定する（旧 profile / connection は無い）", async () => {
    const server = buildMcpServer({
      sessions: new SessionManager(),
      resolver: new ConfigResolver(serverStore(), personalStore()),
      version: "test"
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "1" }, { capabilities: {} });
    await Promise.all([server.connect(b), client.connect(a)]);
    const { tools } = await client.listTools();
    const open = tools.find((t) => t.name === "open_session")!;
    const props = Object.keys(
      (open.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}
    );
    expect(props).toContain("system");
    expect(props).toContain("session");
    expect(props).not.toContain("profile");
    expect(props).not.toContain("connection");
  });
});
