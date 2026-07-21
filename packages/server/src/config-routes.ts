/**
 * システム / セッション設定の CRUD API。
 *
 * 旧 `/api/profiles`（サーバー設定）と `/api/connections`（個人設定）を置き換える。
 * **保管場所の違いは経路ではなく `source` で表す**——階層（システム / セッション）と
 * 保管場所（サーバー / 個人）は直交する軸なので、URL を 4 本に割ると組み合わせが増えるだけになる。
 *
 * 信頼境界（この層が担うのは 2〜4 層目。1・5 層目はスキーマと解決点が担う）:
 *   2 層目: サーバー設定への**書き込みは admin のみ**（`canEditServer`）
 *   3 層目: display 種別では printer 出力を落とす
 *   4 層目: `autoPdfDir` を保存**前**に検証する（不正な設定を永続化しない）
 */
import type { Hono } from "hono";
import { As400Error } from "@as400web/core";
import type { AuthVars } from "./auth.js";
import { checkOutputDir } from "./output-dir.js";
import { checkPrintDest } from "./print-dest.js";
import type { ConfigResolver } from "./config-resolver.js";
import type { ConfigStore } from "./config-store.js";
import { parseRef, type ConfigSource, type Signon } from "./config-types.js";

export interface ConfigRouteDeps {
  resolver: ConfigResolver;
  /** サーバー設定を編集できるか（認証オフ or admin、かつファイル永続化可） */
  canEditServer: (c: { get: (k: "user") => AuthVars["user"] }) => boolean;
}

/** 入力（フラット形式）。UI は signon をネストせずに送る */
interface SystemInput {
  source?: ConfigSource;
  name?: unknown;
  host?: unknown;
  port?: unknown;
  tls?: unknown;
  ccsid?: unknown;
  /** スプール（SCS）用。5250 画面用の ccsid とは別（spec 方針2） */
  spoolCcsid?: unknown;
  autoSignon?: unknown;
  signonUser?: unknown;
  password?: unknown;
  passwordEnv?: unknown;
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

/** 参照文字列を分解する。壊れていれば 400 相当の例外 */
function refOf(raw: string): { source: ConfigSource; id: string } {
  const parsed = parseRef(raw);
  if (!parsed) {
    throw new As400Error("CONFIG_ERROR", `invalid reference "${raw}" (expected srv:<name> or own:<id>)`);
  }
  return parsed;
}

/**
 * フラット入力を保存形（signon をネスト）に直す。
 * パスワードが空なら `signon` に載せない——ストア側が既存を保つ（フォームは空で送られてくる）。
 */
function toSystemRecord(
  input: SystemInput,
  store: ConfigStore,
  existing?: { signon?: Signon | undefined }
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of ["name", "host", "port", "tls", "ccsid", "spoolCcsid"] as const) {
    if (input[k] !== undefined) out[k] = input[k];
  }
  /** 資格情報に触れていない更新では**既存を保つ**。落とすと黙ってパスワードが消える */
  const keep = (): Record<string, unknown> => {
    if (existing?.signon) out.signon = existing.signon;
    return out;
  };
  if (input.autoSignon === false) return out; // 明示オフ＝自動サインオンを解除
  const user = typeof input.signonUser === "string" && input.signonUser !== "" ? input.signonUser : undefined;
  if (input.autoSignon === undefined && user === undefined) return keep();
  if (!user) return keep();
  const signon: Record<string, unknown> = { user };
  if (typeof input.password === "string" && input.password !== "") {
    signon.passwordEnc = store.encryptPassword(input.password);
  } else if (typeof input.passwordEnv === "string" && input.passwordEnv !== "") {
    signon.passwordEnv = input.passwordEnv;
  }
  out.signon = signon;
  return out;
}

/**
 * printer 出力を保存**前**に検証する（信頼境界 4 層目）。
 * `autoPdfDir` はサーバー上の任意パスへの書き込みに直結するため、確実に判定できるものは弾く。
 * 宛先プリンターは確認手段が無い環境もあるので警告に留め、保存は通す。
 *
 * display 種別では検証しない——printer はどのみち落とされるので、
 * 「保存されない設定」を理由に 400 を返すのは利用者を混乱させる。
 */
async function validatePrinter(
  body: unknown
): Promise<{ error?: string; resolved?: string; warnings?: string[] }> {
  const b = body as
    | { printer?: { autoPdfDir?: unknown; autoPrint?: unknown }; sessionType?: unknown }
    | null;
  if (b?.sessionType !== "printer") return {};

  const dir = b?.printer?.autoPdfDir;
  let resolved: string | undefined;
  if (typeof dir === "string" && dir !== "") {
    const r = await checkOutputDir(dir);
    if (!r.ok) return { error: r.reason };
    resolved = r.path;
  }

  const warnings: string[] = [];
  const dest = b?.printer?.autoPrint;
  if (typeof dest === "string" && dest !== "") {
    const d = await checkPrintDest(dest);
    if (d.warn) warnings.push(d.warn);
  }
  return { ...(resolved ? { resolved } : {}), ...(warnings.length ? { warnings } : {}) };
}

/**
 * display 種別に付いてきた printer 出力を落とす（信頼境界 3 層目）。
 * 個人設定ではスキーマが弾くが、サーバー設定は printer を持てるため、種別での破棄が要る。
 */
function dropPrinterForDisplay(body: unknown): unknown {
  if (!body || typeof body !== "object") return body;
  const b = body as Record<string, unknown>;
  if (b.sessionType === "printer") return b;
  const { printer: _ignored, ...rest } = b;
  return rest;
}

export function registerConfigRoutes(app: Hono<{ Variables: AuthVars }>, deps: ConfigRouteDeps): void {
  const { resolver, canEditServer } = deps;

  /** 書き込みの認可（2 層目）。サーバー設定は admin のみ */
  const assertWritable = (source: ConfigSource, c: { get: (k: "user") => AuthVars["user"] }): void => {
    if (source === "server" && !canEditServer(c)) {
      throw new As400Error("FORBIDDEN", "forbidden: server settings are read-only");
    }
  };

  const sourceOf = (body: unknown): ConfigSource =>
    (body as { source?: unknown } | null)?.source === "server" ? "server" : "personal";

  // ---- システム ----

  app.get("/api/systems", (c) => {
    const editable = canEditServer(c);
    // ユーザー名は編集フォームのプレフィル用。編集できない相手には返さない
    return c.json({ systems: resolver.listSystems(c.get("user"), { serverSignon: editable }), editable });
  });

  app.post("/api/systems", async (c) => {
    try {
      const body = (await c.req.json().catch(() => ({}))) as SystemInput;
      const source = sourceOf(body);
      assertWritable(source, c);
      const store = resolver.storeOf(source);
      const system = store.addSystem(toSystemRecord(body, store), c.get("user"));
      await store.save();
      return c.json({ system }, 201);
    } catch (e) {
      return c.json({ error: errMsg(e) }, errStatus(e));
    }
  });

  app.put("/api/systems/:ref", async (c) => {
    try {
      const { source, id } = refOf(c.req.param("ref"));
      assertWritable(source, c);
      const body = (await c.req.json().catch(() => ({}))) as SystemInput;
      const store = resolver.storeOf(source);
      // 既存を読んでから組み立てる（触れていない資格情報を保つため）
      const existing = store.getSystem(id);
      const system = store.updateSystem(id, toSystemRecord(body, store, existing), c.get("user"));
      await store.save();
      return c.json({ system });
    } catch (e) {
      return c.json({ error: errMsg(e) }, errStatus(e));
    }
  });

  app.delete("/api/systems/:ref", async (c) => {
    try {
      const { source, id } = refOf(c.req.param("ref"));
      assertWritable(source, c);
      const store = resolver.storeOf(source);
      store.removeSystem(id, c.get("user"));
      await store.save();
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: errMsg(e) }, errStatus(e));
    }
  });

  // ---- セッション設定 ----

  app.get("/api/sessions-config", (c) =>
    c.json({ sessions: resolver.listSessions(c.get("user")), editable: canEditServer(c) })
  );

  app.post("/api/sessions-config", async (c) => {
    try {
      const raw = await c.req.json().catch(() => ({}));
      const source = sourceOf(raw);
      assertWritable(source, c);
      // 3 層目 → 4 層目の順。落としてから検証しないと、破棄される設定で 400 を返してしまう
      const body = dropPrinterForDisplay(stripSource(raw));
      const { error, resolved, warnings } = await validatePrinter(body);
      if (error) return c.json({ error }, 400);
      const store = resolver.storeOf(source);
      const session = store.addSession(body, c.get("user"));
      await store.save();
      return c.json(
        { session, ...(resolved ? { resolvedPdfDir: resolved } : {}), ...(warnings ? { warnings } : {}) },
        201
      );
    } catch (e) {
      return c.json({ error: errMsg(e) }, errStatus(e));
    }
  });

  app.put("/api/sessions-config/:ref", async (c) => {
    try {
      const { source, id } = refOf(c.req.param("ref"));
      assertWritable(source, c);
      const raw = await c.req.json().catch(() => ({}));
      const body = dropPrinterForDisplay(stripSource(raw));
      const { error, resolved, warnings } = await validatePrinter(body);
      if (error) return c.json({ error }, 400);
      const store = resolver.storeOf(source);
      const session = store.updateSession(id, body, c.get("user"));
      await store.save();
      return c.json({
        session,
        ...(resolved ? { resolvedPdfDir: resolved } : {}),
        ...(warnings ? { warnings } : {})
      });
    } catch (e) {
      return c.json({ error: errMsg(e) }, errStatus(e));
    }
  });

  app.delete("/api/sessions-config/:ref", async (c) => {
    try {
      const { source, id } = refOf(c.req.param("ref"));
      assertWritable(source, c);
      const store = resolver.storeOf(source);
      store.removeSession(id, c.get("user"));
      await store.save();
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: errMsg(e) }, errStatus(e));
    }
  });
}

/** `source` は経路の選択に使うだけで、レコードには残さない */
function stripSource(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const { source: _ignored, system: sysRef, ...rest } = raw as Record<string, unknown>;
  // セッションの `system` は参照文字列（`srv:x`）で届く。保存形は id なので接頭辞を外す
  if (typeof sysRef === "string") {
    const parsed = parseRef(sysRef);
    return { ...rest, system: parsed ? parsed.id : sysRef };
  }
  return rest;
}
