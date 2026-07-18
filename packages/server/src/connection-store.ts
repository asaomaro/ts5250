import { readFileSync } from "node:fs";
import { writeFile, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Tn5250Error, type ConnectOptions } from "@as400web/core";
import { assertOwner, type AuthUser } from "./auth.js";
import type { SecretCrypto } from "./secret-crypto.js";

/**
 * ユーザー接続設定のサーバー保存ストア（localStorage 廃止の受け皿）。
 * - UserStore と同じく JSON＋Map＋tmp→rename の atomic save。
 * - 認可は assertOwner（認証オフ=全通過 / owner 一致 / admin 全許可）。
 * - 自動サインオンのパスワードは SecretCrypto で暗号化して secretEnc に保存（平文は保存しない）。
 * - printer 出力系（autoPdfDir 等）は **スキーマに持たない**（信頼境界。ユーザー入力から注入させない）。
 */

const screenSizeSchema = z.enum(["24x80", "27x132"]);
const sessionTypeSchema = z.enum(["display", "printer"]);

/** API 受理スキーマ（ユーザー入力）。strict で未知キー（printer 出力系など）を拒否する */
const connectionInputSchema = z
  .object({
    name: z.string().min(1),
    host: z.string().min(1),
    port: z.number().int().positive().optional(),
    ccsid: z.number().int().optional(),
    screenSize: screenSizeSchema.optional(),
    deviceName: z.string().optional(),
    tls: z.boolean().optional(),
    sessionType: sessionTypeSchema.default("display"),
    autoSignon: z.boolean().optional(),
    signonUser: z.string().optional(),
    /** 平文パスワード（保存時に暗号化。レスポンス・レコードには残さない） */
    password: z.string().optional()
  })
  .strict();
export type ConnectionInput = z.infer<typeof connectionInputSchema>;

/** 保存レコード（password 平文は持たず secretEnc のみ）。fromFile 検証に使う */
const recordSchema = z
  .object({
    id: z.string().min(1),
    owner: z.string().optional(),
    name: z.string().min(1),
    host: z.string().min(1),
    port: z.number().int().positive().optional(),
    ccsid: z.number().int().optional(),
    screenSize: screenSizeSchema.optional(),
    deviceName: z.string().optional(),
    tls: z.boolean().optional(),
    sessionType: sessionTypeSchema,
    autoSignon: z.boolean().optional(),
    signonUser: z.string().optional(),
    secretEnc: z.string().optional(),
    lastConnectedAt: z.number().optional()
  })
  .strict();
export type ConnectionRecord = z.infer<typeof recordSchema>;

const fileSchema = z.object({ connections: z.array(recordSchema) });

/** API 露出用（秘密を含まない。暗号文も返さず有無だけ hasSecret で示す） */
export interface PublicConnection {
  id: string;
  owner?: string;
  name: string;
  host: string;
  port?: number;
  ccsid?: number;
  screenSize?: "24x80" | "27x132";
  deviceName?: string;
  tls?: boolean;
  sessionType: "display" | "printer";
  autoSignon?: boolean;
  signonUser?: string;
  hasSecret: boolean;
}

function toPublic(r: ConnectionRecord): PublicConnection {
  return {
    id: r.id,
    ...(r.owner !== undefined ? { owner: r.owner } : {}),
    name: r.name,
    host: r.host,
    ...(r.port !== undefined ? { port: r.port } : {}),
    ...(r.ccsid !== undefined ? { ccsid: r.ccsid } : {}),
    ...(r.screenSize !== undefined ? { screenSize: r.screenSize } : {}),
    ...(r.deviceName !== undefined ? { deviceName: r.deviceName } : {}),
    ...(r.tls !== undefined ? { tls: r.tls } : {}),
    sessionType: r.sessionType,
    ...(r.autoSignon !== undefined ? { autoSignon: r.autoSignon } : {}),
    ...(r.signonUser !== undefined ? { signonUser: r.signonUser } : {}),
    hasSecret: r.secretEnc !== undefined
  };
}

export class ConnectionStore {
  private readonly byId = new Map<string, ConnectionRecord>();
  private path: string | undefined;

  constructor(
    records: ConnectionRecord[] = [],
    private readonly crypto?: SecretCrypto
  ) {
    for (const r of records) this.byId.set(r.id, r);
  }

  static fromFile(path: string, crypto?: SecretCrypto): ConnectionStore {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") {
        // 未作成なら空で開始（初回起動）
        const store = new ConnectionStore([], crypto);
        store.path = path;
        return store;
      }
      throw new Tn5250Error("CONFIG_ERROR", `failed to read connections ${path}: ${e.message}`);
    }
    const parsed = fileSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Tn5250Error("CONFIG_ERROR", `invalid connections file: ${parsed.error.message}`);
    }
    const store = new ConnectionStore(parsed.data.connections, crypto);
    store.path = path;
    return store;
  }

  /** 認証オフ=全件 / admin=全件 / 一般=owner 一致のみ（無主レコードは一般には出さない） */
  listForUser(user: AuthUser | undefined): PublicConnection[] {
    const all = [...this.byId.values()];
    const visible =
      !user || user.role === "admin" ? all : all.filter((r) => r.owner !== undefined && r.owner === user.username);
    return visible.map(toPublic);
  }

  get(id: string): ConnectionRecord {
    const r = this.byId.get(id);
    if (!r) throw new Tn5250Error("SESSION_NOT_FOUND", `connection ${id} not found`);
    return r;
  }

  /** 新規作成。owner は認証ユーザー（オフなら無主）。password があれば暗号化して保存 */
  add(inputRaw: unknown, user: AuthUser | undefined): PublicConnection {
    const input = connectionInputSchema.parse(inputRaw);
    const record: ConnectionRecord = {
      id: `c-${randomUUID()}`,
      ...(user ? { owner: user.username } : {}),
      name: input.name,
      host: input.host,
      sessionType: input.sessionType,
      ...(input.port !== undefined ? { port: input.port } : {}),
      ...(input.ccsid !== undefined ? { ccsid: input.ccsid } : {}),
      ...(input.screenSize !== undefined ? { screenSize: input.screenSize } : {}),
      ...(input.deviceName !== undefined ? { deviceName: input.deviceName } : {}),
      ...(input.tls !== undefined ? { tls: input.tls } : {}),
      ...(input.autoSignon !== undefined ? { autoSignon: input.autoSignon } : {}),
      ...(input.signonUser !== undefined ? { signonUser: input.signonUser } : {}),
      ...this.encryptField(input.password)
    };
    this.byId.set(record.id, record);
    return toPublic(record);
  }

  /**
   * 既存を更新（assertOwner 後）。password 規則:
   * 未指定→secretEnc 据え置き / 空文字→secretEnc 削除（自動サインオン解除）/ 非空→再暗号化。
   */
  update(id: string, inputRaw: unknown, user: AuthUser | undefined): PublicConnection {
    const existing = this.get(id);
    assertOwner(existing.owner, user);
    const input = connectionInputSchema.parse(inputRaw);
    const record: ConnectionRecord = {
      id: existing.id,
      ...(existing.owner !== undefined ? { owner: existing.owner } : {}),
      name: input.name,
      host: input.host,
      sessionType: existing.sessionType, // 種別は不変（作成時に確定）
      ...(input.port !== undefined ? { port: input.port } : {}),
      ...(input.ccsid !== undefined ? { ccsid: input.ccsid } : {}),
      ...(input.screenSize !== undefined ? { screenSize: input.screenSize } : {}),
      ...(input.deviceName !== undefined ? { deviceName: input.deviceName } : {}),
      ...(input.tls !== undefined ? { tls: input.tls } : {}),
      ...(input.autoSignon !== undefined ? { autoSignon: input.autoSignon } : {}),
      ...(input.signonUser !== undefined ? { signonUser: input.signonUser } : {}),
      ...(existing.lastConnectedAt !== undefined ? { lastConnectedAt: existing.lastConnectedAt } : {}),
      ...this.secretForUpdate(input.password, existing.secretEnc)
    };
    this.byId.set(id, record);
    return toPublic(record);
  }

  remove(id: string, user: AuthUser | undefined): void {
    const existing = this.get(id);
    assertOwner(existing.owner, user);
    this.byId.delete(id);
  }

  /** 所有移動用: owner チェック付きで生レコード（secretEnc 含む）を取得する */
  getOwned(id: string, user: AuthUser | undefined): ConnectionRecord {
    const r = this.get(id);
    assertOwner(r.owner, user);
    return r;
  }

  /** 所有移動用: 完成済みレコードを追加（同名 id は無いので衝突チェック不要。サーバー内専用） */
  addRecord(record: ConnectionRecord): PublicConnection {
    this.byId.set(record.id, record);
    return toPublic(record);
  }

  /** 新規レコード用の id を採番する（移動時に profile→connection を作る用） */
  static newId(): string {
    return `c-${randomUUID()}`;
  }

  /**
   * open 用に core の ConnectOptions へ解決する（assertOwner 後）。
   * secretEnc があれば復号して user/password を載せる。復号失敗時は password 無しで続行し warn する
   * （レコードは壊さない。鍵ローテーション等での不整合に耐える）。
   */
  resolveConnectOptions(
    id: string,
    user: AuthUser | undefined,
    warn?: (msg: string) => void
  ): ConnectOptions {
    const r = this.get(id);
    assertOwner(r.owner, user);
    const opts: ConnectOptions = { host: r.host };
    if (r.port !== undefined) opts.port = r.port;
    if (r.tls !== undefined) opts.tls = r.tls;
    if (r.ccsid !== undefined) opts.ccsid = r.ccsid;
    if (r.screenSize !== undefined) opts.screenSize = r.screenSize;
    if (r.deviceName !== undefined) opts.deviceName = r.deviceName;
    if (r.autoSignon && r.signonUser && r.secretEnc && this.crypto) {
      try {
        opts.user = r.signonUser;
        opts.password = this.crypto.decrypt(r.secretEnc);
      } catch {
        delete opts.user;
        delete opts.password;
        warn?.(`connection ${id}: failed to decrypt saved password (auto-signon skipped)`);
      }
    }
    return opts;
  }

  /** 接続成功時刻を記録（任意。save は呼び側） */
  markConnected(id: string, now: number): void {
    const r = this.byId.get(id);
    if (r) r.lastConnectedAt = now;
  }

  async save(): Promise<void> {
    if (!this.path) return;
    const json = JSON.stringify({ connections: [...this.byId.values()] }, null, 2);
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, json, "utf8");
    await rename(tmp, this.path);
  }

  get size(): number {
    return this.byId.size;
  }

  /** password → { secretEnc }（暗号化）。鍵未設定でパスワード指定は拒否 */
  private encryptField(password: string | undefined): { secretEnc?: string } {
    if (password === undefined || password === "") return {};
    if (!this.crypto) {
      throw new Tn5250Error("CONFIG_ERROR", "secret key not configured; cannot store password");
    }
    return { secretEnc: this.crypto.encrypt(password) };
  }

  /** update 時の secretEnc 決定（据え置き/削除/再暗号化） */
  private secretForUpdate(password: string | undefined, current: string | undefined): { secretEnc?: string } {
    if (password === undefined) return current !== undefined ? { secretEnc: current } : {};
    if (password === "") return {}; // 明示的な解除
    return this.encryptField(password);
  }
}
