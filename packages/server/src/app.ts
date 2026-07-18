import { Hono } from "hono";
import { Tn5250Error } from "@as400web/core";
import { StreamableHTTPTransport } from "@hono/mcp";
import { upgradeWebSocket } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { buildMcpServer } from "./mcp-server.js";
import { WsConnection } from "./ws-handler.js";
import { renderSpoolPdf } from "./pdf.js";
import {
  assertOwner,
  createAuthMiddleware,
  registerAuthRoutes,
  resolveUser,
  type AuthContext,
  type AuthVars
} from "./auth.js";
import { registerAdminRoutes } from "./admin.js";
import { registerConnectionRoutes } from "./connections.js";
import type { AuditBuffer } from "./audit.js";
import type { ToolDeps } from "./mcp-tools.js";

export interface AppDeps extends ToolDeps {
  /** web-ui のビルド成果物ディレクトリ（subtask 03 で配線。未指定ならプレースホルダ） */
  webRoot?: string;
  /** 認証コンテキスト（未指定 or enabled=false なら無認証＝後方互換） */
  auth?: AuthContext;
  /** 監査ログバッファ（管理者画面のログ取得用） */
  audit?: AuditBuffer;
}

/**
 * Hono アプリ（REST＋MCP Streamable HTTP＋静的配信）。
 * 認証が有効なら /api/*・/ws・/mcp を保護し、per-user でセッション/帳票を分離する。
 */
export function buildApp(deps: AppDeps): Hono<{ Variables: AuthVars }> {
  const app = new Hono<{ Variables: AuthVars }>();

  // 認証（設定時のみ）。ミドルウェアは最初に適用する
  if (deps.auth) {
    app.use("*", createAuthMiddleware(deps.auth));
    registerAuthRoutes(app, deps.auth);
    // 管理者 API（監査バッファがあればログも）
    if (deps.audit) registerAdminRoutes(app, { auth: deps.auth, sessions: deps.sessions, audit: deps.audit });
  }
  // /api/me は認証 OFF でも常に応答（web-ui がログイン要否を判定するため）
  const auth = deps.auth;
  app.get("/api/me", (c) =>
    auth?.enabled ? c.json({ enabled: true, user: resolveUser(c, auth) ?? null }) : c.json({ enabled: false })
  );

  app.get("/healthz", (c) => c.json({ status: "ok", sessions: deps.sessions.size }));
  app.get("/api/version", (c) => c.json({ name: "as400-5250", version: deps.version }));
  app.get("/api/profiles", (c) => c.json({ profiles: deps.profiles.listPublic() }));

  // ユーザー接続設定 CRUD（サーバー保存・owner スコープ）。ストア配線時のみ
  if (deps.connections) registerConnectionRoutes(app, { connections: deps.connections });

  // 受信スプールを PDF でダウンロード（web-ui / 任意クライアント向け・オンデマンド生成）
  app.get("/api/spool/:sessionId/:spoolId/pdf", async (c) => {
    const { sessionId, spoolId } = c.req.param();
    try {
      const entry = deps.sessions.getPrinter(sessionId);
      assertOwner(entry.owner, c.get("user")); // 所有者のみ（認証 OFF は全通過・admin は全許可）
      const report = entry.reports.find((r) => r.id === spoolId);
      if (!report) return c.json({ error: "spool not found" }, 404);
      const pdf = await renderSpoolPdf(report.pages);
      return new Response(new Uint8Array(pdf), {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="${spoolId}.pdf"`
        }
      });
    } catch (e) {
      if (e instanceof Tn5250Error && e.code === "FORBIDDEN") return c.json({ error: e.message }, 403);
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 404);
    }
  });

  // MCP over Streamable HTTP（@hono/mcp）。ステートレス（接続はリクエスト毎に管理）。
  // 認証時は per-request の認証ユーザーをツールに渡し、per-user 分離を効かせる
  app.all("/mcp", async (c) => {
    const user = c.get("user");
    const server = buildMcpServer(user ? { ...deps, user } : deps);
    const transport = new StreamableHTTPTransport();
    await server.connect(transport);
    return transport.handleRequest(c);
  });

  // WebSocket（1 接続 = 1 セッション）。@hono/node-server の内蔵 upgradeWebSocket
  app.get(
    "/ws",
    upgradeWebSocket((c) => {
      let conn: WsConnection | undefined;
      const user = c.get("user"); // 認証時の接続ユーザー（開くセッションの owner）
      return {
        onOpen(_evt, ws) {
          conn = new WsConnection(
            deps,
            {
              send: (data) => ws.send(data),
              close: () => ws.close()
            },
            user
          );
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
