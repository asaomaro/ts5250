/**
 * マクロ（画面操作の記録・再生）の CRUD API。
 *
 * 保管場所は個人設定と同じく**所有者付きの単一ファイル**（`macros.json`）なので、
 * `config-routes.ts` のような `source`（サーバー / 個人）の分岐は持たない。
 * 認可は `MacroStore` 側の `assertOwner` に集約する（経路ごとに書かない）。
 *
 * **秘密の出入りはこの 1 か所だけ**（spec D5）:
 *   - 入る: `POST` の `steps[].plainSecrets`。ストアが暗号化し、平文はその場で捨てる
 *   - 出る: **どこからも出ない**。応答は `PublicMacro`（`secretEnc` を落とした形）
 * 更新（PUT）を改名だけに絞っているのは、ステップの部分更新を許すと
 * 「秘密だけ差し替える」経路ができ、上の不変条件が崩れるため。差し替えは記録し直す。
 */
import type { Hono } from "hono";
import { As400Error } from "@as400web/core";
import type { AuthVars } from "./auth.js";
import type { MacroStore } from "./macro-store.js";

export interface MacroRouteDeps {
  macros: MacroStore;
  /** 現在時刻（ms）。テストから差し替えられるようにする */
  now?: () => number;
}

function errStatus(e: unknown): 400 | 403 | 404 {
  if (e instanceof As400Error) {
    if (e.code === "FORBIDDEN") return 403;
    if (e.code === "SESSION_NOT_FOUND") return 404;
  }
  return 400;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function registerMacroRoutes(app: Hono<{ Variables: AuthVars }>, deps: MacroRouteDeps): void {
  const { macros } = deps;
  const now = deps.now ?? ((): number => Date.now());

  app.get("/api/macros", (c) =>
    c.json({
      macros: macros.list(c.get("user")),
      // 鍵が無い環境では「保存する」を選ばせない（UI が「毎回入力する」へ誘導する）
      canStoreSecrets: macros.canStoreSecrets
    })
  );

  app.post("/api/macros", async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const macro = macros.create(body, c.get("user"), now());
      await macros.save();
      return c.json({ macro }, 201);
    } catch (e) {
      return c.json({ error: errMsg(e) }, errStatus(e));
    }
  });

  app.put("/api/macros/:id", async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const macro = macros.rename(c.req.param("id"), body, c.get("user"), now());
      await macros.save();
      return c.json({ macro });
    } catch (e) {
      return c.json({ error: errMsg(e) }, errStatus(e));
    }
  });

  app.delete("/api/macros/:id", async (c) => {
    try {
      macros.remove(c.req.param("id"), c.get("user"));
      await macros.save();
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: errMsg(e) }, errStatus(e));
    }
  });
}
