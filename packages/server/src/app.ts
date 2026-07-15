import { Hono } from "hono";
import { StreamableHTTPTransport } from "@hono/mcp";
import { upgradeWebSocket } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { buildMcpServer } from "./mcp-server.js";
import { WsConnection } from "./ws-handler.js";
import type { ToolDeps } from "./mcp-tools.js";

export interface AppDeps extends ToolDeps {
  /** web-ui のビルド成果物ディレクトリ（subtask 03 で配線。未指定ならプレースホルダ） */
  webRoot?: string;
}

/**
 * Hono アプリ（REST＋MCP Streamable HTTP＋静的配信）。
 * WebSocket ルート（/ws）は subtask 03 で追加する。
 */
export function buildApp(deps: AppDeps): Hono {
  const app = new Hono();

  app.get("/healthz", (c) => c.json({ status: "ok", sessions: deps.sessions.size }));
  app.get("/api/version", (c) => c.json({ name: "as400-5250", version: deps.version }));
  app.get("/api/profiles", (c) => c.json({ profiles: deps.profiles.listPublic() }));

  // MCP over Streamable HTTP（@hono/mcp）。ステートレス（接続はリクエスト毎に管理）
  app.all("/mcp", async (c) => {
    const server = buildMcpServer(deps);
    const transport = new StreamableHTTPTransport();
    await server.connect(transport);
    return transport.handleRequest(c);
  });

  // WebSocket（1 接続 = 1 セッション）。@hono/node-server の内蔵 upgradeWebSocket
  app.get(
    "/ws",
    upgradeWebSocket(() => {
      let conn: WsConnection | undefined;
      return {
        onOpen(_evt, ws) {
          conn = new WsConnection(deps, {
            send: (data) => ws.send(data),
            close: () => ws.close()
          });
        },
        onMessage(evt, _ws) {
          const data = typeof evt.data === "string" ? evt.data : String(evt.data);
          void conn?.handle(data);
        },
        onClose() {
          conn?.onSocketClose();
        }
      };
    })
  );

  // web-ui 静的配信。webRoot 指定時はビルド済み dist を配信（SPA: 未マッチは index.html）
  if (deps.webRoot) {
    const root = deps.webRoot;
    app.use("/assets/*", serveStatic({ root }));
    app.get("*", serveStatic({ path: "index.html", root }));
  } else {
    app.get("/", (c) =>
      c.html("<!doctype html><title>5250</title><p>Web UI を配信するには --web-root を指定してください。</p>")
    );
  }

  return app;
}
