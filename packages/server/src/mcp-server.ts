import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools, type ToolDeps } from "./mcp-tools.js";
import { registerHostServerTools } from "./host-server-tools.js";

/**
 * ツール登録済みの McpServer を生成する（stdio・HTTP の両方から使う）。
 *
 * 5250 経由（`mcp-tools`）とホストサーバー経由（`host-server-tools`）を**ここで合流させる**。
 * 片方がもう片方を import すると循環参照になるため、登録の呼び出しはこの 1 箇所に置く。
 */
export function buildMcpServer(deps: ToolDeps): McpServer {
  const server = new McpServer({ name: "as400-5250", version: deps.version });
  registerTools(server, deps);
  registerHostServerTools(server, deps);
  return server;
}
