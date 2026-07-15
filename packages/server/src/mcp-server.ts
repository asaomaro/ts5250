import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools, type ToolDeps } from "./mcp-tools.js";

/** ツール登録済みの McpServer を生成する（stdio・HTTP の両方から使う） */
export function buildMcpServer(deps: ToolDeps): McpServer {
  const server = new McpServer({ name: "as400-5250", version: deps.version });
  registerTools(server, deps);
  return server;
}
