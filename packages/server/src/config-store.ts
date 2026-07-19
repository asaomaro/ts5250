/**
 * 接続設定のストア（システム / セッション設定）。
 *
 * サーバー設定（profiles.json）と個人設定（connections.json）は**信頼境界が違う**ため、
 * ファイルを分けたまま、それぞれの中を 2 階層にする。共通処理を基底クラスに置き、
 * 差分（セッションスキーマ・認可・id の採り方）だけを派生で与える。
 *
 * **`dirty` フラグを持たない**（design の判断）。「移行したから書く」経路を作らないことで、
 * 勝手なファイル書き換えが構造的に起きない。書き出しは CRUD からの明示呼び出しに限る。
 */
import { readFileSync } from "node:fs";
import { writeFile, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { As400Error } from "@as400web/core";
import { assertOwner, assertProfileAccess, type AuthUser } from "./auth.js";
import type { SecretCrypto } from "./secret-crypto.js";
import {
  makeRef,
  personalConfigSchema,
  personalSessionSchema,
  serverConfigSchema,
  serverSessionSchema,
  systemSchema,
  type AnySession,
  type ConfigSource,
  type PersonalSession,
  type PublicSession,
  type PublicSystem,
  type ServerSession,
  type System
} from "./config-types.js";
import {
  isLegacyConnections,
  isLegacyProfiles,
  migrateConnections,
  migrateProfiles,
  type Warn
} from "./config-migrate.js";

export interface StoreData {
  systems: System[];
  sessions: AnySession[];
}

export abstract class ConfigStore {
  protected readonly systems = new Map<string, System>();
  protected readonly sessions = new Map<string, AnySession>();
  private path: string | undefined;

  abstract readonly source: ConfigSource;
  /** この保管場所のセッションスキーマ（信頼境界の 1 層目を型で表す） */
  protected abstract get sessionSchema(): z.ZodType<AnySession>;

  constructor(
    data: StoreData = { systems: [], sessions: [] },
    protected readonly crypto?: SecretCrypto
  ) {
    for (const s of data.systems) this.systems.set(s.id, s);
    for (const s of data.sessions) this.sessions.set(s.id, s);
  }

  /** 保存できるか（ファイル由来のときのみ編集を永続化できる） */
  get persistable(): boolean {
    return this.path !== undefined;
  }

  protected setPath(p: string): void {
    this.path = p;
  }

  /**
   * 参照の整合性を確認する。セッションが**ファイル外**のシステムを指していたら起動を止める。
   * 移行後の不整合を黙認すると、接続時になって初めて分かることになる。
   */
  protected assertIntegrity(): void {
    for (const s of this.sessions.values()) {
      if (!this.systems.has(s.system)) {
        throw new As400Error(
          "CONFIG_ERROR",
          `session ${s.name} references missing system ${s.system}`
        );
      }
    }
  }

  // ---- 参照 ----

  getSystem(id: string): System {
    const s = this.systems.get(id);
    if (!s) throw new As400Error("SESSION_NOT_FOUND", `system ${id} not found`);
    return s;
  }

  getSession(id: string): AnySession {
    const s = this.sessions.get(id);
    if (!s) throw new As400Error("SESSION_NOT_FOUND", `session ${id} not found`);
    return s;
  }

  /** 認可（保管場所ごとに異なる）。派生で実装する */
  abstract assertAccess(owner: string | undefined, user: AuthUser | undefined): void;

  /**
   * @param opts.includeSignon 自動サインオンの**ユーザー名**を含める（編集フォームのプレフィル用）。
   *   パスワードは決して返さない。既定 false——MCP など機械向けの一覧に内部の値を渡さないため。
   */
  listSystems(user: AuthUser | undefined, opts?: { includeSignon?: boolean }): PublicSystem[] {
    return [...this.systems.values()]
      .filter((s) => this.canSee(s.owner, user))
      .map((s) => this.publicSystem(s, opts));
  }

  listSessions(user: AuthUser | undefined): PublicSession[] {
    return [...this.sessions.values()]
      .filter((s) => this.canSee(this.ownerOf(s), user))
      .map((s) => this.publicSession(s));
  }

  private canSee(owner: string | undefined, user: AuthUser | undefined): boolean {
    try {
      this.assertAccess(owner, user);
      return true;
    } catch {
      return false;
    }
  }

  protected ownerOf(s: AnySession): string | undefined {
    return "owner" in s ? s.owner : undefined;
  }

  /**
   * API 露出用のシステム。**資格情報を返さない**（user 名も暗号文も出さない）。
   * システムは資格情報の集約点なので、ここが緩むと一発で漏れる。
   */
  protected publicSystem(s: System, opts?: { includeSignon?: boolean }): PublicSystem {
    const pub: PublicSystem = {
      ref: makeRef(this.source, s.id),
      name: s.name,
      host: s.host,
      autoSignon: s.signon !== undefined
    };
    if (s.port !== undefined) pub.port = s.port;
    if (s.tls !== undefined) pub.tls = s.tls;
    if (s.ccsid !== undefined) pub.ccsid = s.ccsid;
    if (s.owner !== undefined) pub.owner = s.owner;
    // ユーザー名は編集フォームのプレフィル用にだけ返す。**パスワード機構は決して返さない**
    if (opts?.includeSignon && s.signon?.user !== undefined) pub.signonUser = s.signon.user;
    return pub;
  }

  /** API 露出用のセッション。**printer 出力を返さない**（信頼設定） */
  protected publicSession(s: AnySession): PublicSession {
    const pub: PublicSession = {
      ref: makeRef(this.source, s.id),
      name: s.name,
      system: makeRef(this.source, s.system),
      sessionType: s.sessionType
    };
    if (s.deviceName !== undefined) pub.deviceName = s.deviceName;
    if (s.screenSize !== undefined) pub.screenSize = s.screenSize;
    if (s.ccsid !== undefined) pub.ccsid = s.ccsid;
    if (s.enhanced !== undefined) pub.enhanced = s.enhanced;
    const owner = this.ownerOf(s);
    if (owner !== undefined) pub.owner = owner;
    return pub;
  }

  // ---- 更新 ----

  addSystem(raw: unknown, user: AuthUser | undefined): PublicSystem {
    // owner は**入力から採らない**。認証オフ（user 未定義）でも入力値が残らないよう先に落とす。
    // 弾かずに無視するのは、UI が一覧の応答（owner を含む）をそのまま送り返せるようにするため
    const parsed = systemSchema.omit({ id: true }).parse(stripOwner(raw));
    const sys: System = { ...parsed, id: this.newSystemId(parsed.name) };
    delete sys.owner;
    if (this.source === "personal" && user) sys.owner = user.username;
    this.assertAccess(sys.owner, user);
    if (this.systems.has(sys.id)) {
      throw new As400Error("FORBIDDEN", `system ${sys.id} already exists`);
    }
    this.systems.set(sys.id, sys);
    return this.publicSystem(sys);
  }

  updateSystem(id: string, raw: unknown, user: AuthUser | undefined): PublicSystem {
    const existing = this.getSystem(id);
    this.assertAccess(existing.owner, user);
    const parsed = systemSchema.omit({ id: true }).parse(stripOwner(raw));
    const sys: System = { ...parsed, id };
    // 所有者は入力から変えさせない（なりすまし防止）。既存を復元する
    delete sys.owner;
    if (existing.owner !== undefined) sys.owner = existing.owner;
    // パスワードは未指定なら既存を保つ（フォームは空で送られてくる）
    if (sys.signon && sys.signon.passwordEnc === undefined && sys.signon.passwordEnv === undefined) {
      if (existing.signon?.passwordEnc !== undefined) sys.signon.passwordEnc = existing.signon.passwordEnc;
      else if (existing.signon?.passwordEnv !== undefined) sys.signon.passwordEnv = existing.signon.passwordEnv;
    }
    this.systems.set(id, sys);
    return this.publicSystem(sys);
  }

  removeSystem(id: string, user: AuthUser | undefined): void {
    const existing = this.getSystem(id);
    this.assertAccess(existing.owner, user);
    // 子が残っていると参照が壊れる。先に片付けさせる
    const children = [...this.sessions.values()].filter((s) => s.system === id);
    if (children.length > 0) {
      throw new As400Error(
        "FORBIDDEN",
        `system ${id} still has ${children.length} session(s); remove them first`
      );
    }
    this.systems.delete(id);
  }

  addSession(raw: unknown, user: AuthUser | undefined): PublicSession {
    const parsed = this.parseSessionInput(raw);
    const s = { ...parsed, id: this.newSessionId(parsed.name) } as AnySession;
    if (this.source === "personal" && user) (s as PersonalSession).owner = user.username;
    this.assertAccess(this.ownerOf(s), user);
    // 参照先はこのファイル内にしか存在しえない（スコープ規定）
    this.getSystem(s.system);
    if (this.sessions.has(s.id)) {
      throw new As400Error("FORBIDDEN", `session ${s.id} already exists`);
    }
    this.sessions.set(s.id, s);
    return this.publicSession(s);
  }

  updateSession(id: string, raw: unknown, user: AuthUser | undefined): PublicSession {
    const existing = this.getSession(id);
    this.assertAccess(this.ownerOf(existing), user);
    const parsed = this.parseSessionInput(raw);
    const s = { ...parsed, id } as AnySession;
    const owner = this.ownerOf(existing);
    if (owner !== undefined) (s as PersonalSession).owner = owner;
    this.getSystem(s.system);
    this.sessions.set(id, s);
    return this.publicSession(s);
  }

  removeSession(id: string, user: AuthUser | undefined): void {
    const existing = this.getSession(id);
    this.assertAccess(this.ownerOf(existing), user);
    this.sessions.delete(id);
  }

  /**
   * 入力の検証。**このストアのセッションスキーマを使う**——個人設定に printer を送ると
   * ここで落ちる（`.strict()`）。信頼境界の 1 層目。
   */
  private parseSessionInput(raw: unknown): Omit<AnySession, "id"> {
    const schema = this.sessionSchema as unknown as z.ZodObject<z.ZodRawShape>;
    return schema.omit({ id: true }).parse(stripOwner(raw)) as Omit<AnySession, "id">;
  }

  protected newSystemId(name: string): string {
    return this.source === "server" ? name : `s-${randomUUID()}`;
  }

  protected newSessionId(name: string): string {
    return this.source === "server" ? name : `c-${randomUUID()}`;
  }

  /** パスワードを暗号化する（平文は保存しない） */
  encryptPassword(plain: string): string {
    if (!this.crypto) {
      throw new As400Error("CONFIG_ERROR", "secret key not configured; cannot store password");
    }
    return this.crypto.encrypt(plain);
  }

  get secretCrypto(): SecretCrypto | undefined {
    return this.crypto;
  }

  /** 原子的に保存（tmp→rename）。**CRUD からの明示呼び出しのみ** */
  async save(): Promise<void> {
    if (!this.path) return;
    const json = JSON.stringify(
      { systems: [...this.systems.values()], sessions: [...this.sessions.values()] },
      null,
      2
    );
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, json, "utf8");
    await rename(tmp, this.path);
  }
}

/** サーバー設定（profiles.json）。admin 専用。printer 出力を持てる */
export class ServerConfigStore extends ConfigStore {
  readonly source = "server" as const;
  protected get sessionSchema(): z.ZodType<AnySession> {
    return serverSessionSchema as unknown as z.ZodType<AnySession>;
  }

  assertAccess(_owner: string | undefined, user: AuthUser | undefined): void {
    assertProfileAccess(user);
  }

  static fromFile(path: string, crypto?: SecretCrypto, warn: Warn = () => {}): ServerConfigStore {
    const raw = readJson(path, "profiles");
    assertNoPlaintextPassword(raw);
    const data = isLegacyProfiles(raw)
      ? migrateProfiles(raw.profiles, warn)
      : parseOrThrow(serverConfigSchema, raw, "profiles.json");
    const store = new ServerConfigStore(
      { systems: data.systems, sessions: data.sessions as ServerSession[] },
      crypto
    );
    store.setPath(path);
    store.assertIntegrity();
    return store;
  }
}

/** 個人設定（connections.json）。所有者のみ。**printer 出力を持てない** */
export class PersonalConfigStore extends ConfigStore {
  readonly source = "personal" as const;
  protected get sessionSchema(): z.ZodType<AnySession> {
    return personalSessionSchema as unknown as z.ZodType<AnySession>;
  }

  assertAccess(owner: string | undefined, user: AuthUser | undefined): void {
    assertOwner(owner, user);
  }

  static fromFile(path: string, crypto?: SecretCrypto, warn: Warn = () => {}): PersonalConfigStore {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      // 未作成は空で開始する（個人設定は起動時に無くて当然）
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        const empty = new PersonalConfigStore({ systems: [], sessions: [] }, crypto);
        empty.setPath(path);
        return empty;
      }
      throw new As400Error("CONFIG_ERROR", `failed to read connections ${path}: ${(err as Error).message}`);
    }
    const data = isLegacyConnections(raw)
      ? migrateConnections(raw.connections, warn)
      : parseOrThrow(personalConfigSchema, raw, "connections.json");
    const store = new PersonalConfigStore(
      { systems: data.systems, sessions: data.sessions as PersonalSession[] },
      crypto
    );
    store.setPath(path);
    store.assertIntegrity();
    return store;
  }
}

// ---- 補助 ----

/**
 * 入力から `owner` を落とす。所有者は**リクエストの文脈から決める**ものであって、
 * 本文で指定させない（なりすまし防止）。エラーにせず無視するのは、
 * UI が一覧の応答をそのまま編集して送り返す使い方を壊さないため。
 */
function stripOwner(raw: unknown): unknown {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const { owner: _ignored, ...rest } = raw as Record<string, unknown>;
    return rest;
  }
  return raw;
}

function readJson(path: string, what: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new As400Error("CONNECT_FAILED", `failed to read ${what} ${path}: ${(err as Error).message}`);
  }
}

function parseOrThrow<T>(schema: z.ZodType<T>, raw: unknown, what: string): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new As400Error("CONNECT_FAILED", `invalid ${what}: ${parsed.error.message}`);
  }
  return parsed.data;
}

/**
 * 平文 `signon.password` は廃止。黙って無視すると自動サインオンが静かに壊れるため、
 * 明示エラーで気づける形にする（旧実装から引き継ぐ）。
 */
function assertNoPlaintextPassword(raw: unknown): void {
  const profs = (raw as { profiles?: unknown } | null)?.profiles;
  if (!Array.isArray(profs)) return;
  for (const p of profs) {
    if (p && typeof p === "object" && (p as { signon?: { password?: unknown } }).signon?.password !== undefined) {
      throw new As400Error(
        "CONNECT_FAILED",
        `profile ${(p as { name?: string }).name ?? "?"}: signon.password (平文) は廃止されました。` +
          `passwordEnv（環境変数）を使うか、UI からパスワードを設定してください（passwordEnc）`
      );
    }
  }
}
