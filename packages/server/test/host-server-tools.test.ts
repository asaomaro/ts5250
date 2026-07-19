import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../src/mcp-server.js";
import { SessionManager } from "../src/session-manager.js";
import { ServerConfigStore, PersonalConfigStore } from "../src/config-store.js";
import { ConfigResolver } from "../src/config-resolver.js";
import { hostAuthFrom } from "../src/host-connect.js";
import type { AuthUser } from "../src/auth.js";

/**
 * ホストサーバー経由の MCP ツール。
 *
 * **実際の取得は実機でしか確かめられない**（host-lists.test.ts と同じ立場）。
 * ここで固定するのは、実機に触れずに壊れうるもの——
 * ツールの登録・引数スキーマ・資格情報の扱い・接続先未指定の扱い、そして既存 5250 ツールの回帰。
 */

/** ホストサーバー経由で公開すると決めた 10 本（spec 5. 受け入れ基準） */
const HOST_TOOLS = [
  "host_sql",
  "host_command",
  "host_call_program",
  "host_list_spools",
  "host_get_spool",
  "host_read_file",
  "host_write_file",
  "host_list_jobs",
  "host_list_objects",
  "host_list_users"
];

/** 5250 経由の既存ツール。名前が変わっていないことを確かめる（後方互換） */
const LEGACY_TOOLS = [
  "open_session",
  "signon",
  "close_session",
  "list_sessions",
  "list_systems",
  "list_session_configs",
  "open_printer_session",
  "wait_spool",
  "list_spools",
  "get_spool",
  "get_spool_pdf",
  "get_screen",
  "wait_screen",
  "set_fields",
  "send_key",
  "select_gui_choice",
  "submit_gui_selection",
  "run_steps",
  "get_job_info"
];

/** 資格情報を持たない接続設定。実機へ出て行かないので単体テストで使える */
function stores(): { server: ServerConfigStore; personal: PersonalConfigStore } {
  return {
    server: new ServerConfigStore({
      systems: [{ id: "noauth", name: "noauth", host: "example.invalid" }],
      sessions: [{ id: "noauth-d", name: "noauth-d", system: "noauth", sessionType: "display" }]
    }),
    personal: new PersonalConfigStore()
  };
}

async function connect(user?: AuthUser) {
  const { server: s, personal } = stores();
  const server = buildMcpServer({
    sessions: new SessionManager(),
    resolver: new ConfigResolver(s, personal),
    version: "test",
    ...(user ? { user } : {})
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" }, { capabilities: {} });
  await Promise.all([server.connect(b), client.connect(a)]);
  return client;
}

async function call(name: string, args: Record<string, unknown>, user?: AuthUser) {
  const client = await connect(user);
  return (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    structuredContent?: { error?: { code?: string; message?: string } };
    content?: { text: string }[];
  };
}

describe("ツールの登録", () => {
  it("ホストサーバー経由の 10 本が登録されている", async () => {
    const client = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const t of HOST_TOOLS) expect(names).toContain(t);
  });

  it("既存の 5250 ツールが消えていない（後方互換）", async () => {
    const client = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const t of LEGACY_TOOLS) expect(names).toContain(t);
  });

  it("経路が名前で判別できる（ホストサーバー経由は host_ 接頭辞）", async () => {
    const client = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name);
    // 既存の list_spools（push 型）と host_list_spools（pull 型）が併存し、混ざっていない
    expect(names).toContain("list_spools");
    expect(names).toContain("host_list_spools");
    for (const t of HOST_TOOLS) expect(t.startsWith("host_")).toBe(true);
  });
});

describe("資格情報をツール引数に取らない（D13）", () => {
  it("どのツールの入力スキーマにも user / password が無い", async () => {
    const client = await connect();
    const tools = (await client.listTools()).tools.filter((t) => HOST_TOOLS.includes(t.name));
    expect(tools).toHaveLength(HOST_TOOLS.length);
    for (const t of tools) {
      const props = Object.keys(
        (t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}
      );
      expect(props).not.toContain("user");
      expect(props).not.toContain("password");
      // host も直接指定させない（接続先は必ず保存済み設定を経由する）
      expect(props).not.toContain("host");
    }
  });
});

describe("接続先の指定", () => {
  it("system も session も無ければ CONFIG_ERROR", async () => {
    const r = await call("host_sql", { sql: "SELECT 1 FROM SYSIBM.SYSDUMMY1" });
    expect(r.isError).toBe(true);
    expect(r.structuredContent?.error?.code).toBe("CONFIG_ERROR");
  });

  it("存在しない参照は解決に失敗する", async () => {
    // ConfigResolver は未知の参照を SESSION_NOT_FOUND として返す（未指定の CONFIG_ERROR と区別される）
    const r = await call("host_command", { system: "srv:nosuch", command: "DSPJOB" });
    expect(r.isError).toBe(true);
    expect(r.structuredContent?.error?.code).toBe("SESSION_NOT_FOUND");
  });
});

describe("資格情報を持たない接続設定", () => {
  // 全 10 本が同じヘルパ（hostAuthFrom）を通ることを、実際にツールを叩いて確かめる。
  // ここが緩むと「実機に出て行ってから失敗する」ツールが生まれる。
  const argsFor: Record<string, Record<string, unknown>> = {
    host_sql: { sql: "SELECT 1 FROM SYSIBM.SYSDUMMY1" },
    host_command: { command: "DSPJOB" },
    host_call_program: { program: "QGYOLSPL", library: "QGY", params: [] },
    host_list_spools: {},
    host_get_spool: {
      id: { jobName: "J", jobUser: "U", jobNumber: "1", fileName: "F", fileNumber: 1 }
    },
    host_read_file: { path: "/tmp/x" },
    host_write_file: { path: "/tmp/x", content: "hi" },
    host_list_jobs: {},
    host_list_objects: {},
    host_list_users: {}
  };

  for (const name of HOST_TOOLS) {
    it(`${name}: 理由の分かる CONFIG_ERROR を返す`, async () => {
      const r = await call(name, { system: "srv:noauth", ...argsFor[name] });
      expect(r.isError).toBe(true);
      expect(r.structuredContent?.error?.code).toBe("CONFIG_ERROR");
      expect(r.structuredContent?.error?.message).toMatch(/ユーザーとパスワード/);
    });
  }
});

describe("hostAuthFrom", () => {
  it("tls をそのまま渡す（boolean に潰さない）", () => {
    // ConnectOptions.tls は boolean | { rejectUnauthorized?, ca? }。
    // 旧実装は `as boolean` でキャストしており、証明書検証の設定を落とすように読めた
    const auth = hostAuthFrom({
      host: "h",
      user: "u",
      password: "p",
      tls: { rejectUnauthorized: false }
    });
    expect(auth.tls).toEqual({ rejectUnauthorized: false });
  });

  it("tls 未指定なら鍵ごと落とす（undefined を指定した扱いにしない）", () => {
    const auth = hostAuthFrom({ host: "h", user: "u", password: "p" });
    expect("tls" in auth).toBe(false);
  });

  it("host / user / password のどれが欠けても CONFIG_ERROR", () => {
    expect(() => hostAuthFrom({ user: "u", password: "p" })).toThrow(/ユーザーとパスワード/);
    expect(() => hostAuthFrom({ host: "h", password: "p" })).toThrow(/ユーザーとパスワード/);
    expect(() => hostAuthFrom({ host: "h", user: "u" })).toThrow(/ユーザーとパスワード/);
  });
});

describe("入力の検証", () => {
  it("maxRows の上限を超えると拒否する", async () => {
    const r = await call("host_sql", {
      system: "srv:noauth",
      sql: "SELECT 1 FROM SYSIBM.SYSDUMMY1",
      maxRows: 99999
    });
    expect(r.isError).toBe(true);
  });

  it("一覧の max の上限を超えると拒否する", async () => {
    const r = await call("host_list_jobs", { system: "srv:noauth", max: 99999 });
    expect(r.isError).toBe(true);
  });

  it("host_get_spool は id の全項目を要求する", async () => {
    const r = await call("host_get_spool", {
      system: "srv:noauth",
      id: { jobName: "J" }
    });
    expect(r.isError).toBe(true);
  });
});
