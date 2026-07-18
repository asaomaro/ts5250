import type { Hono } from "hono";
import { z } from "zod";
import { Tn5250Error } from "@as400web/core";
import { requireAdmin, type AuthVars, type AuthUser } from "./auth.js";
import { ProfileStore, type Profile } from "./profiles.js";
import { ConnectionStore, type ConnectionRecord } from "./connection-store.js";

/**
 * 接続設定の所有（共有＝profile / 個人＝connection）を移動する管理者向け操作。
 * - 秘密は `secretEnc`（connection）と `signon.passwordEnc`（profile）が**同一 AES-256-GCM 形式**なので文字列で移送する。
 * - `passwordEnv`（env 参照）は個人へ移せないため破棄（要再入力）。`printer` 出力（信頼設定）は個人に持てないため破棄。
 * - admin 限定（認証オフには個人が無く移動は不要）。
 */
export interface MoveDeps {
  profiles: ProfileStore;
  connections: ConnectionStore;
}

const moveSchema = z.object({
  kind: z.enum(["connection", "profile"]),
  /** connection の id、または profile の name */
  id: z.string().min(1),
  to: z.enum(["shared", "personal"])
});

/** ConnectionRecord → Profile（personal → shared）。secretEnc を signon.passwordEnc として移送 */
function connectionToProfile(rec: ConnectionRecord): Profile {
  const p: Profile = { name: rec.name, host: rec.host, sessionType: rec.sessionType };
  if (rec.port !== undefined) p.port = rec.port;
  if (rec.tls !== undefined) p.tls = rec.tls;
  if (rec.ccsid !== undefined) p.ccsid = rec.ccsid;
  if (rec.screenSize !== undefined) p.screenSize = rec.screenSize;
  if (rec.deviceName !== undefined) p.deviceName = rec.deviceName;
  if (rec.autoSignon && rec.signonUser) {
    p.signon = { user: rec.signonUser, ...(rec.secretEnc !== undefined ? { passwordEnc: rec.secretEnc } : {}) };
  }
  return p;
}

/** Profile → ConnectionRecord（shared → personal）。passwordEnv/printer は個人に持てないため破棄（warn） */
function profileToConnection(
  prof: Profile,
  owner: AuthUser
): { record: ConnectionRecord; warnings: string[] } {
  const warnings: string[] = [];
  const type = prof.sessionType ?? (prof.printer !== undefined ? "printer" : "display");
  const record: ConnectionRecord = {
    id: ConnectionStore.newId(),
    owner: owner.username,
    name: prof.name,
    host: prof.host,
    sessionType: type
  };
  if (prof.port !== undefined) record.port = prof.port;
  if (prof.tls !== undefined) record.tls = prof.tls;
  if (prof.ccsid !== undefined) record.ccsid = prof.ccsid;
  if (prof.screenSize !== undefined) record.screenSize = prof.screenSize;
  if (prof.deviceName !== undefined) record.deviceName = prof.deviceName;
  if (prof.signon) {
    record.autoSignon = true;
    record.signonUser = prof.signon.user;
    if (prof.signon.passwordEnc !== undefined) {
      record.secretEnc = prof.signon.passwordEnc; // 同一形式で移送
    } else if (prof.signon.passwordEnv !== undefined) {
      warnings.push("passwordEnv（環境変数）は個人接続へ移せません。パスワードを再入力してください。");
    }
  }
  if (prof.printer !== undefined) {
    warnings.push("PDF 出力設定（autoPdfDir/autoPrint）は個人接続に持てないため破棄しました。");
  }
  return { record, warnings };
}

function moveErr(e: unknown): 400 | 403 | 404 | 409 {
  if (e instanceof Tn5250Error) {
    if (e.code === "SESSION_NOT_FOUND") return 404;
    if (e.code === "FORBIDDEN") return 409; // 移動先で同名が既存
  }
  return 400;
}

export function registerMoveRoutes(app: Hono<{ Variables: AuthVars }>, deps: MoveDeps): void {
  app.use("/api/settings/move", requireAdmin()); // 所有移動は admin 限定
  app.post("/api/settings/move", async (c) => {
    const parsed = moveSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const { kind, id, to } = parsed.data;
    const user = c.get("user");
    try {
      if (kind === "connection" && to === "shared") {
        const rec = deps.connections.getOwned(id, user);
        deps.profiles.addRecord(connectionToProfile(rec)); // 同名 profile があれば FORBIDDEN→409
        await deps.profiles.save();
        deps.connections.remove(id, user);
        await deps.connections.save();
        return c.json({ ok: true, name: rec.name });
      }
      if (kind === "profile" && to === "personal") {
        const prof = deps.profiles.getRaw(id); // id=name
        const { record, warnings } = profileToConnection(prof, user!);
        deps.connections.addRecord(record);
        await deps.connections.save();
        deps.profiles.remove(id);
        await deps.profiles.save();
        return c.json({ ok: true, id: record.id, warnings });
      }
      return c.json({ error: "unsupported move（既にその所有か、kind/to の不一致）" }, 400);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, moveErr(e));
    }
  });
}
