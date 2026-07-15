import { readFileSync } from "node:fs";
import { z } from "zod";
import { Tn5250Error, type ConnectOptions } from "@as400web/core";

const signonSchema = z.object({
  user: z.string().min(1),
  /** パスワードを保持する環境変数名（推奨）。平文 password より優先 */
  passwordEnv: z.string().min(1).optional(),
  /** 平文パスワード（非推奨。passwordEnv を使うこと） */
  password: z.string().optional()
});

const profileSchema = z.object({
  name: z.string().min(1),
  host: z.string().min(1),
  port: z.number().int().positive().optional(),
  tls: z.boolean().optional(),
  ccsid: z.number().int().optional(),
  screenSize: z.enum(["24x80", "27x132"]).optional(),
  deviceName: z.string().optional(),
  enhanced: z.boolean().optional(),
  signon: signonSchema.optional()
});

const configSchema = z.object({
  profiles: z.array(profileSchema)
});

export type Profile = z.infer<typeof profileSchema>;

/** API 露出用にサニタイズしたプロファイル（認証情報を含まない。spec: 名前とホストのみ相当） */
export interface PublicProfile {
  name: string;
  host: string;
  port?: number;
  tls?: boolean;
  ccsid?: number;
  screenSize?: "24x80" | "27x132";
  autoSignon: boolean;
}

export class ProfileStore {
  private readonly byName = new Map<string, Profile>();

  constructor(profiles: Profile[]) {
    for (const p of profiles) this.byName.set(p.name, p);
  }

  static fromFile(path: string): ProfileStore {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      throw new Tn5250Error("CONNECT_FAILED", `failed to read profiles ${path}: ${(err as Error).message}`);
    }
    const parsed = configSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Tn5250Error("CONNECT_FAILED", `invalid profiles.json: ${parsed.error.message}`);
    }
    return new ProfileStore(parsed.data.profiles);
  }

  get(name: string): Profile {
    const p = this.byName.get(name);
    if (!p) throw new Tn5250Error("SESSION_NOT_FOUND", `profile ${name} not found`);
    return p;
  }

  /** API 露出用の一覧（認証情報なし） */
  listPublic(): PublicProfile[] {
    return [...this.byName.values()].map((p) => {
      const pub: PublicProfile = { name: p.name, host: p.host, autoSignon: p.signon !== undefined };
      if (p.port !== undefined) pub.port = p.port;
      if (p.tls !== undefined) pub.tls = p.tls;
      if (p.ccsid !== undefined) pub.ccsid = p.ccsid;
      if (p.screenSize !== undefined) pub.screenSize = p.screenSize;
      return pub;
    });
  }

  /**
   * プロファイルを core の ConnectOptions に解決する（passwordEnv → 実際のパスワード）。
   * signon があれば RFC 4777 自動サインオン（user/password）を設定する（D3）。
   * 認証情報はここで解決してサーバー内に留め、外へ返さない（D13）。
   */
  resolveConnectOptions(name: string): ConnectOptions {
    const p = this.get(name);
    const opts: ConnectOptions = { host: p.host };
    if (p.port !== undefined) opts.port = p.port;
    if (p.ccsid !== undefined) opts.ccsid = p.ccsid;
    if (p.deviceName !== undefined) opts.deviceName = p.deviceName;
    if (p.enhanced !== undefined) opts.enhanced = p.enhanced;
    if (p.signon) {
      const password = p.signon.passwordEnv
        ? process.env[p.signon.passwordEnv]
        : p.signon.password;
      if (password === undefined || password === "") {
        throw new Tn5250Error(
          "CONNECT_FAILED",
          `profile ${name}: password not available (env ${p.signon.passwordEnv ?? "?"} unset)`
        );
      }
      opts.user = p.signon.user;
      opts.password = password;
    }
    return opts;
  }
}
