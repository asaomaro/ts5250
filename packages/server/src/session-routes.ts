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
import { As400Error } from "@ts5250/base";
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

  /**
   * **ページを離れるときの切断通知**（`navigator.sendBeacon` の受け口）。
   *
   * WebSocket の `{type:"close"}` はソケットが生きているタブからしか送れない。心拍が途絶えて切れていた
   * （放置したタブが止まった等）セッションは、既定で時間では切らない（`DEFAULT_STALLED_GRACE_MS`）ので、
   * そのタブを閉じたときに**この口で終わらせないと、利用者にも見えないまま残る**。
   *
   * **自分の分だけ**（`close` の `assertOwner`）。id は推測できない UUID で、認証オフは単一の信頼ユーザー。
   * 存在しない・既に閉じた id は 404（`pagehide` は二重に来るので、呼び手は結果を見ない）。
   */
  app.post("/api/sessions/:id/close", async (c) => {
    try {
      await deps.sessions.close(c.req.param("id"), c.get("user"));
      return c.json({ ok: true });
    } catch (e) {
      const code = e instanceof As400Error ? e.code : undefined;
      const status = code === "FORBIDDEN" ? 403 : code === "SESSION_NOT_FOUND" ? 404 : 500;
      return c.json({ error: e instanceof Error ? e.message : String(e) }, status);
    }
  });
}
