import { Hono } from "hono";
import { As400Error } from "@as400web/core";
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
import { registerConfigRoutes } from "./config-routes.js";
import { registerHostListRoutes } from "./host-lists.js";
import { registerHostSqlRoutes } from "./host-sql.js";
import { registerHostUploadRoutes } from "./host-upload.js";
import { ResultSetStore } from "./result-set-store.js";
import { DbPool } from "./db-pool.js";
import type { AuditBuffer } from "./audit.js";
import type { ToolDeps } from "./mcp-tools.js";

export interface AppDeps extends ToolDeps {
  /** web-ui のビルド成果物ディレクトリ（subtask 03 で配線。未指定ならプレースホルダ） */
  webRoot?: string;
  /** 認証コンテキスト（未指定 or enabled=false なら無認証＝後方互換） */
  auth?: AuthContext;
  /** 監査ログバッファ（管理者画面のログ取得用） */
  audit?: AuditBuffer;
  /** SQL 結果セットの保持（画面のページング用）。未指定なら内部で作る */
  resultSets?: ResultSetStore;
  /** 画面の SQL 用の接続の使い回し。未指定なら内部で作る */
  pool?: DbPool;
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
  }
  // 管理者 API。認証オフ（＝実質管理者）でもセッション管理とログは使える。
  // ユーザー管理は auth があるときだけ登録される（admin.ts 側で判定）
  if (deps.audit) {
    registerAdminRoutes(app, {
      ...(deps.auth ? { auth: deps.auth } : {}),
      sessions: deps.sessions,
      audit: deps.audit
    });
  }
  // /api/me は認証 OFF でも常に応答（web-ui がログイン要否を判定するため）
  const auth = deps.auth;
  app.get("/api/me", (c) =>
    auth?.enabled
      ? (() => {
          const u = resolveUser(c, auth);
          // hasToken は UI の「発行済み / 未発行」表示用。トークンの値そのものは返さない
          return c.json({ enabled: true, user: u ?? null, ...(u ? { hasToken: auth.users.hasToken(u.username) } : {}) });
        })()
      : c.json({ enabled: false })
  );

  app.get("/healthz", (c) => c.json({ status: "ok", sessions: deps.sessions.size }));
  app.get("/api/version", (c) => c.json({ name: "as400-5250", version: deps.version }));

  /**
   * 自分の API トークンを発行する（MCP/自動化用）。**自分の分だけ**——ユーザー名は
   * 認証済みコンテキストから取り、パスパラメータを受けない（他人の分を発行しようがない）。
   * 再発行すると以前のトークンは失効する。平文はここでの応答限りで、保存はハッシュのみ。
   */
  app.post("/api/me/token", async (c) => {
    const a = deps.auth;
    if (!a?.enabled) return c.json({ error: "authentication is disabled" }, 400);
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthorized" }, 401);
    const token = a.users.issueToken(user.username);
    await a.users.save();
    return c.json({ token }, 201);
  });
  /**
   * サーバー設定の編集可否: 認証オフ（ローカル）または admin のみ。かつファイル由来（永続化可能）のとき。
   * **信頼境界の 2 層目**——printer 出力（サーバー上の任意パスへの書き込み）を受け付けてよい経路の判定。
   */
  const canEditServer = (c: { get: (k: "user") => AuthVars["user"] }): boolean => {
    const a = deps.auth;
    const permitted = !a || !a.enabled ? true : c.get("user")?.role === "admin";
    return permitted && deps.resolver.storeOf("server").persistable;
  };

  // システム / セッション設定の CRUD（信頼境界 2〜4 層目は config-routes 側）
  registerConfigRoutes(app, { resolver: deps.resolver, canEditServer });

  // ジョブ・オブジェクト・ユーザー一覧（接続を持つユーザーなら誰でも。
  // 見える範囲は IBM i の権限が決めるため、アプリ側で追加の制限は掛けない）
  registerHostListRoutes(app, { resolver: deps.resolver });
  const resultSets = deps.resultSets ?? new ResultSetStore();
  const pool = deps.pool ?? new DbPool();
  registerHostSqlRoutes(app, { resolver: deps.resolver, resultSets, pool });

  // CSV の取り込み（DDM）。**ここは IBM i に書き込むルート**——
  // 読み取り専用なのは /api/host/sql であって、ホスト API 全体ではない（host-upload.ts の説明）
  registerHostUploadRoutes(app, { resolver: deps.resolver });

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
      if (e instanceof As400Error && e.code === "FORBIDDEN") return c.json({ error: e.message }, 403);
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

  /**
   * 未登録の API パスは JSON の 404 で返す。**静的配信のフォールバックより前**に置くこと。
   *
   * SPA のために `app.get("*")` で index.html へフォールバックしているが、これは `/api/*` まで拾って
   * しまい、API クライアントが JSON を期待して HTML を受け取る・タイポが 200 で隠れる・404 による
   * 機能検出が使えない、という問題が起きていた（--web-root の有無で同じパスの応答が変わっていた）。
   * webRoot の有無に関わらず適用し、挙動を一致させる。
   */
  app.all("/api/*", (c) => c.json({ error: `not found: ${c.req.path}` }, 404));

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
