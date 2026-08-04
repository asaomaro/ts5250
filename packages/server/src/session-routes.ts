/**
 * **いま開いているセッションの一覧**（自分の分だけ）。
 *
 * MCP や HLLAPI が開いた画面をブラウザから開く（attach）ための導線に使う。
 *
 * **`/api/admin/sessions` を使わない理由:** あちらは `listAll()` で**全利用者**を返す。
 * admin が既定で他人の画面を開く導線は作らない
 * （`20260803-hllapi-bridge` で `Connect("A")` の既定を自分に限定したのと同じ判断）。
 */
import type { Hono } from "hono";
import type { AuthVars } from "./auth.js";
import type { SessionManager } from "./session-manager.js";

export interface SessionRouteDeps {
  sessions: SessionManager;
}

export function registerSessionRoutes(app: Hono<{ Variables: AuthVars }>, deps: SessionRouteDeps): void {
  app.get("/api/sessions", (c) => {
    const user = c.get("user");
    const sessions = deps.sessions.list(user).map((e) => {
      const r = deps.sessions.reservationOf(e.id);
      return {
        sessionId: e.id,
        host: e.host,
        origin: e.origin,
        connectedAt: e.connectedAt,
        readOnly: e.readOnly,
        /** 何人が見ているか。**0 なら誰も見ていない**（MCP が開いたものなど） */
        viewers: e.viewers,
        ...(e.target?.name !== undefined ? { name: e.target.name } : {}),
        ...(r ? { reservedBy: r.label } : {})
      };
    });
    return c.json({ sessions });
  });
}
