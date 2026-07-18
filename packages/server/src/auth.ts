import { readFileSync } from "node:fs";
import { writeFile, rename } from "node:fs/promises";
import { scryptSync, randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { z } from "zod";
import type { Context, Hono, MiddlewareHandler } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { Tn5250Error } from "@as400web/core";

/**
 * 認証・per-user 分離（PR 1）。Node 標準 crypto のみで完結（新規依存なし）。
 * - パスワード: scrypt（salt 付き）。トークン: sha256。比較は timingSafeEqual。
 * - ブラウザは Cookie セッション（in-memory・httpOnly）、MCP/自動化は API トークン（Bearer）。
 * - 認証 OFF 時は user=undefined で全通過（後方互換）。
 */

export type Role = "admin" | "user";
export interface AuthUser {
  username: string;
  role: Role;
}

const SCRYPT_KEYLEN = 64;

/** パスワード → `saltHex:hashHex`（scrypt） */
export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(pw, salt, SCRYPT_KEYLEN);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

/** タイミング安全にパスワードを検証する */
export function verifyPasswordHash(pw: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltHex, "hex");
    expected = Buffer.from(hashHex, "hex");
  } catch {
    return false;
  }
  if (expected.length === 0) return false;
  const actual = scryptSync(pw, salt, expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** API トークン → sha256 hex（users.json には tokenHashes として保存） */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function timingSafeStrEq(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

const userRecordSchema = z.object({
  username: z.string().min(1),
  role: z.enum(["admin", "user"]),
  passwordHash: z.string().min(1),
  tokenHashes: z.array(z.string()).optional()
});
const usersSchema = z.object({ users: z.array(userRecordSchema) });
export type UserRecord = z.infer<typeof userRecordSchema>;

/** API 露出用のユーザー（ハッシュを含まない） */
export interface PublicUser {
  username: string;
  role: Role;
  tokenCount: number;
}

export class UserStore {
  private readonly byName = new Map<string, UserRecord>();
  private path: string | undefined;

  constructor(users: UserRecord[]) {
    for (const u of users) this.byName.set(u.username, u);
  }

  static fromFile(path: string): UserStore {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      throw new Tn5250Error("CONNECT_FAILED", `failed to read users ${path}: ${(err as Error).message}`);
    }
    const parsed = usersSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Tn5250Error("CONNECT_FAILED", `invalid users file: ${parsed.error.message}`);
    }
    const store = new UserStore(parsed.data.users);
    store.path = path;
    return store;
  }

  /** API 露出用の一覧（ハッシュなし） */
  listPublic(): PublicUser[] {
    return [...this.byName.values()].map((u) => ({
      username: u.username,
      role: u.role,
      tokenCount: u.tokenHashes?.length ?? 0
    }));
  }

  has(username: string): boolean {
    return this.byName.has(username);
  }

  /** ユーザーを追加（存在すれば FORBIDDEN）。password は平文（内部で scrypt ハッシュ） */
  add(username: string, password: string, role: Role): void {
    if (this.byName.has(username)) throw new Tn5250Error("FORBIDDEN", `user ${username} already exists`);
    this.byName.set(username, { username, role, passwordHash: hashPassword(password), tokenHashes: [] });
  }

  /** role / password を更新 */
  update(username: string, changes: { role?: Role; password?: string }): void {
    const u = this.byName.get(username);
    if (!u) throw new Tn5250Error("SESSION_NOT_FOUND", `user ${username} not found`);
    if (changes.role) u.role = changes.role;
    if (changes.password) u.passwordHash = hashPassword(changes.password);
  }

  remove(username: string): void {
    if (!this.byName.delete(username)) throw new Tn5250Error("SESSION_NOT_FOUND", `user ${username} not found`);
  }

  /**
   * 新しい API トークンを発行し、ハッシュを保存して**平文を 1 回だけ返す**。
   *
   * 追加ではなく**置き換え**る（1 ユーザー 1 トークン）。追加方式だと有効なトークンが増え続け、
   * 漏洩しても「どれを消すか」を特定できず全消しするしかなくなるため。
   * 再発行＝以前のトークンは即座に失効する。
   *
   * スキーマは配列のまま（既存 users.json に複数入っていても読めるようにする。読み込みは
   * 複数を受け付け、発行時に 1 本へ収束させる）。
   */
  issueToken(username: string): string {
    const u = this.byName.get(username);
    if (!u) throw new Tn5250Error("SESSION_NOT_FOUND", `user ${username} not found`);
    const token = randomBytes(24).toString("hex");
    u.tokenHashes = [hashToken(token)];
    return token;
  }

  /** そのユーザーが API トークンを発行済みか（UI の状態表示用。値は返さない） */
  hasToken(username: string): boolean {
    return (this.byName.get(username)?.tokenHashes?.length ?? 0) > 0;
  }

  /** users.json へ原子的に保存（tmp→rename）。fromFile 由来のときのみ */
  async save(): Promise<void> {
    if (!this.path) return;
    const json = JSON.stringify({ users: [...this.byName.values()] }, null, 2);
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, json, "utf8");
    await rename(tmp, this.path);
  }

  /** username/password を検証して AuthUser を返す（失敗は undefined） */
  verifyPassword(username: string, password: string): AuthUser | undefined {
    const u = this.byName.get(username);
    if (!u) {
      // ユーザー不存在でも scrypt を 1 回回してタイミング差を減らす
      verifyPasswordHash(password, `${"0".repeat(32)}:${"0".repeat(128)}`);
      return undefined;
    }
    if (!verifyPasswordHash(password, u.passwordHash)) return undefined;
    return { username: u.username, role: u.role };
  }

  /** API トークンからユーザーを引く（sha256 を timingSafe 比較） */
  findByToken(token: string): AuthUser | undefined {
    const th = hashToken(token);
    for (const u of this.byName.values()) {
      for (const stored of u.tokenHashes ?? []) {
        if (timingSafeStrEq(stored, th)) return { username: u.username, role: u.role };
      }
    }
    return undefined;
  }

  get size(): number {
    return this.byName.size;
  }
}

/** Cookie セッション（in-memory・失効可能）。sid は 256bit 乱数。 */
export class SessionStore {
  private readonly sessions = new Map<string, { user: AuthUser; expires: number }>();

  constructor(
    private readonly ttlMs = 12 * 60 * 60_000,
    private readonly now: () => number = () => Date.now()
  ) {}

  create(user: AuthUser): string {
    const sid = randomBytes(32).toString("hex");
    this.sessions.set(sid, { user, expires: this.now() + this.ttlMs });
    return sid;
  }

  get(sid: string): AuthUser | undefined {
    const s = this.sessions.get(sid);
    if (!s) return undefined;
    if (s.expires < this.now()) {
      this.sessions.delete(sid);
      return undefined;
    }
    return s.user;
  }

  destroy(sid: string): void {
    this.sessions.delete(sid);
  }
}

/** 認証コンテキスト（app に渡す）。enabled=false なら無認証（後方互換）。 */
export interface AuthContext {
  enabled: boolean;
  users: UserStore;
  sessions: SessionStore;
  /** Cookie に Secure を付けるか（TLS 配信時 true） */
  cookieSecure?: boolean;
}

/**
 * 資源の所有者チェック。認証 OFF（user 未定義）なら許可、admin なら許可、
 * owner 一致なら許可、それ以外は FORBIDDEN。
 */
export function assertOwner(owner: string | undefined, user: AuthUser | undefined): void {
  if (!user) return; // 認証 OFF
  if (user.role === "admin") return;
  if (owner !== undefined && owner === user.username) return;
  throw new Tn5250Error("FORBIDDEN", "forbidden: not the owner of this session");
}

/**
 * サーバー設定（profiles）へのアクセス可否。認証オフ=全通過 / admin=許可 / 一般ユーザー=FORBIDDEN。
 * profiles は信頼設定（サーバーのパス書込・lp 実行・資格情報）の置き場なので、一般ユーザーには
 * 参照も利用もさせない。一覧から隠すだけ（obscurity）にせず、名指しの解決もここで塞ぐ。
 */
export function assertProfileAccess(user: AuthUser | undefined): void {
  if (!user) return; // 認証 OFF
  if (user.role === "admin") return;
  throw new Tn5250Error("FORBIDDEN", "forbidden: server settings are admin only");
}

/** hono の Variables 型（c.get("user") で認証ユーザーを取れる） */
export type AuthVars = { user?: AuthUser };

/** リクエストから認証ユーザーを解決する（Bearer トークン優先、次に Cookie セッション） */
export function resolveUser(c: Context, auth: AuthContext): AuthUser | undefined {
  const authz = c.req.header("authorization");
  if (authz && authz.startsWith("Bearer ")) {
    const u = auth.users.findByToken(authz.slice(7).trim());
    if (u) return u;
  }
  const sid = getCookie(c, "sid");
  if (sid) return auth.sessions.get(sid);
  return undefined;
}

/**
 * 認証ミドルウェア。enabled=false なら素通り（後方互換）。
 * /api/login・/api/me・/healthz・/api/version と静的配信は公開、それ以外の /api/*・/ws・/mcp を保護する。
 */
export function createAuthMiddleware(auth: AuthContext): MiddlewareHandler<{ Variables: AuthVars }> {
  return async (c, next) => {
    if (!auth.enabled) return next();
    const p = c.req.path;
    const isPublic = p === "/api/login" || p === "/api/me" || p === "/healthz" || p === "/api/version";
    const isProtected = p.startsWith("/api/") || p.startsWith("/ws") || p.startsWith("/mcp");
    if (isPublic || !isProtected) return next(); // 公開エンドポイント・静的配信（ログインページ等）
    const user = resolveUser(c, auth);
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    c.set("user", user);
    return next();
  };
}

/** admin 専用ルート用ミドルウェア（role!=="admin" は 403）。authMiddleware の後に適用する。 */
/**
 * admin 限定ガード。**認証オフは通す**——個人利用は「単一の信頼ユーザー」＝実質管理者として扱う
 * （assertOwner / assertProfileAccess と同じ「認証オフ＝全通過」の規則に揃える）。
 * 認証オフかどうかは AuthContext の有無で判定する（未指定なら常に user が無く区別できないため）。
 */
export function requireAdmin(authEnabled = true): MiddlewareHandler<{ Variables: AuthVars }> {
  return async (c, next) => {
    if (!authEnabled) return next();
    const user = c.get("user");
    if (!user || user.role !== "admin") return c.json({ error: "forbidden: admin only" }, 403);
    return next();
  };
}

/** /api/login・/api/logout・/api/me を登録する */
export function registerAuthRoutes(app: Hono<{ Variables: AuthVars }>, auth: AuthContext): void {
  app.post("/api/login", async (c) => {
    if (!auth.enabled) return c.json({ error: "auth disabled" }, 400);
    const body = (await c.req.json().catch(() => ({}))) as { username?: unknown; password?: unknown };
    const user =
      typeof body.username === "string" && typeof body.password === "string"
        ? auth.users.verifyPassword(body.username, body.password)
        : undefined;
    if (!user) return c.json({ error: "invalid credentials" }, 401);
    const sid = auth.sessions.create(user);
    setCookie(c, "sid", sid, { httpOnly: true, sameSite: "Lax", secure: auth.cookieSecure ?? false, path: "/" });
    return c.json({ user });
  });

  app.post("/api/logout", (c) => {
    const sid = getCookie(c, "sid");
    if (sid) auth.sessions.destroy(sid);
    deleteCookie(c, "sid", { path: "/" });
    return c.json({ ok: true });
  });
}
