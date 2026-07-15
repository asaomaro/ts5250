#!/usr/bin/env node
import { serve, type WebSocketServerLike } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { log } from "@as400web/core";
import { SessionManager } from "./session-manager.js";
import { ProfileStore } from "./profiles.js";
import { buildMcpServer } from "./mcp-server.js";
import { buildApp } from "./app.js";
import type { ToolDeps } from "./mcp-tools.js";

const VERSION = "0.1.0";

interface Args {
  mode: "stdio" | "http";
  port: number;
  profilesPath: string | undefined;
  webRoot: string | undefined;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { mode: "http", port: 3400, profilesPath: undefined, webRoot: undefined };
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

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  const deps = buildDeps(args.profilesPath);

  if (args.mode === "stdio") {
    // stdio モード: stdout は MCP 専用（ログは stderr のみ = core log）
    const server = buildMcpServer(deps);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    log.info("5250 MCP server started on stdio");
  } else {
    const app = buildApp(args.webRoot ? { ...deps, webRoot: args.webRoot } : deps);
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
