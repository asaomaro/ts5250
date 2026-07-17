import { readFileSync } from "node:fs";
import { z } from "zod";
import { Tn5250Error, type ConnectOptions } from "@as400web/core";
import type { PrinterOutputConfig } from "./printer-output.js";

/** プリンターセッションのサーバー側出力設定（PDF 自動蓄積・自動印刷）。信頼設定なのでプロファイルにのみ置く */
const printerSchema = z.object({
  autoPdfDir: z.string().optional(),
  autoPrint: z.string().optional(),
  pdfFontPath: z.string().optional(),
  pdfFontName: z.string().optional(),
  pageSize: z.string().optional(),
  fontSize: z.number().positive().optional()
});

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
  signon: signonSchema.optional(),
  printer: printerSchema.optional()
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
    // 転記漏れがあると平文で繋がってしまう。ポート省略時の既定は tls で 992／平文で 23 のため、
    // tls:true だけ書いたプロファイルは「23 番へ平文で接続して成功する」＝気づけない形になる。
    if (p.tls !== undefined) opts.tls = p.tls;
    if (p.ccsid !== undefined) opts.ccsid = p.ccsid;
    if (p.screenSize !== undefined) opts.screenSize = p.screenSize;
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

  /**
   * プロファイルのプリンター出力設定を解決する（PDF 自動蓄積・自動印刷）。未設定なら undefined。
   * **信頼されたサーバー設定のみ**をここから供給し、ブラウザ由来の値は使わない（任意パス書込・任意
   * コマンド実行の防止）。
   */
  resolvePrinterOutput(name: string): PrinterOutputConfig | undefined {
    const pr = this.get(name).printer;
    if (!pr || (!pr.autoPdfDir && !pr.autoPrint)) return undefined;
    const cfg: PrinterOutputConfig = {};
    if (pr.autoPdfDir !== undefined) cfg.autoPdfDir = pr.autoPdfDir;
    if (pr.autoPrint !== undefined) cfg.autoPrint = pr.autoPrint;
    const pdf: NonNullable<PrinterOutputConfig["pdf"]> = {};
    if (pr.pdfFontPath !== undefined) pdf.fontPath = pr.pdfFontPath;
    if (pr.pdfFontName !== undefined) pdf.fontName = pr.pdfFontName;
    if (pr.pageSize !== undefined) pdf.pageSize = pr.pageSize;
    if (pr.fontSize !== undefined) pdf.fontSize = pr.fontSize;
    if (Object.keys(pdf).length > 0) cfg.pdf = pdf;
    return cfg;
  }
}
