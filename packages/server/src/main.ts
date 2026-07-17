#!/usr/bin/env node
import { serve, type WebSocketServerLike } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { log } from "@as400web/core";
import { SessionManager } from "./session-manager.js";
import { ProfileStore } from "./profiles.js";
import { buildMcpServer } from "./mcp-server.js";
import { buildApp } from "./app.js";
import { UserStore, SessionStore, hashPassword, type AuthContext } from "./auth.js";
import type { ToolDeps } from "./mcp-tools.js";

const VERSION = "0.1.0";

interface Args {
  mode: "stdio" | "http";
  port: number;
  profilesPath: string | undefined;
  webRoot: string | undefined;
  usersPath: string | undefined;
  hashPassword: string | undefined;
  cookieSecure: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    mode: "http",
    port: 3400,
    profilesPath: undefined,
    webRoot: undefined,
    usersPath: undefined,
    hashPassword: undefined,
    cookieSecure: false
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--stdio") args.mode = "stdio";
    else if (a === "--http") {
      args.mode = "http";
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        args.port = Number(next);
        i++;
      }
    } else if (a === "--profiles") {
      args.profilesPath = argv[++i];
    } else if (a === "--web-root") {
      args.webRoot = argv[++i];
    } else if (a === "--users") {
      // ユーザーファイル指定で認証を有効化（per-user 分離）
      args.usersPath = argv[++i];
    } else if (a === "--cookie-secure") {
      args.cookieSecure = true;
    } else if (a === "--hash-password") {
      // ユーティリティ: users.json 用の scrypt ハッシュを出力して終了
      args.hashPassword = argv[++i];
    }
  }
  return args;
}

function buildDeps(profilesPath: string | undefined): ToolDeps {
  const profiles = profilesPath ? ProfileStore.fromFile(profilesPath) : new ProfileStore([]);
  const sessions = new SessionManager();
  sessions.startIdleSweep();
  return { sessions, profiles, version: VERSION };
}

/** 認証コンテキストを構築（--users 指定時のみ enabled）。 */
function buildAuth(usersPath: string | undefined, cookieSecure: boolean): AuthContext | undefined {
  if (!usersPath) return undefined;
  return { enabled: true, users: UserStore.fromFile(usersPath), sessions: new SessionStore(), cookieSecure };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);

  // ユーティリティ: パスワードハッシュを出力して終了（users.json 作成補助）
  if (args.hashPassword !== undefined) {
    process.stdout.write(hashPassword(args.hashPassword) + "\n");
    return;
  }

  const deps = buildDeps(args.profilesPath);
  const auth = buildAuth(args.usersPath, args.cookieSecure);
  if (auth) log.info("authentication enabled (per-user isolation)");

  if (args.mode === "stdio") {
    // stdio モード: stdout は MCP 専用（ログは stderr のみ = core log）
    const server = buildMcpServer(deps);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    log.info("5250 MCP server started on stdio");
  } else {
    const app = buildApp({
      ...deps,
      ...(args.webRoot ? { webRoot: args.webRoot } : {}),
      ...(auth ? { auth } : {})
    });
    // ws の WebSocketServer は WebSocketServerLike と互換（noServer:true 指定済み。optional 差のみ）
    const wss = new WebSocketServer({ noServer: true }) as unknown as WebSocketServerLike;
    serve({ fetch: app.fetch, port: args.port, websocket: { server: wss } }, (info) => {
      log.info({ port: info.port }, "5250 MCP/Web server started (Streamable HTTP + WebSocket)");
    });
  }
}

// このファイルが直接実行されたときのみ起動（テストからの import では起動しない）
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    log.error({ err }, "server failed to start");
    process.exit(1);
  });
}
