import { readFileSync } from "node:fs";
import { writeFile, rename } from "node:fs/promises";
import { z } from "zod";
import { Tn5250Error, type ConnectOptions } from "@as400web/core";
import type { PrinterOutputConfig } from "./printer-output.js";
import type { SecretCrypto } from "./secret-crypto.js";

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
  /** パスワードを保持する環境変数名（運用者向け・env 注入） */
  passwordEnv: z.string().min(1).optional(),
  /** UI 設定の暗号化パスワード（AES-256-GCM の `v1:iv:tag:ct`）。passwordEnv より優先 */
  passwordEnc: z.string().optional()
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
  /** 種別（明示）。未設定なら printer ブロックの有無から導出（後方互換） */
  sessionType: z.enum(["display", "printer"]).optional(),
  signon: signonSchema.optional(),
  printer: printerSchema.optional()
});

/** プロファイルの実効種別（明示 sessionType 優先、無ければ printer ブロック有無から導出） */
function effectiveType(p: {
  sessionType?: "display" | "printer" | undefined;
  printer?: unknown;
}): "display" | "printer" {
  return p.sessionType ?? (p.printer !== undefined ? "printer" : "display");
}

const configSchema = z.object({
  profiles: z.array(profileSchema)
});

export type Profile = z.infer<typeof profileSchema>;
export type PrinterConfig = z.infer<typeof printerSchema>;

/** API 露出用にサニタイズしたプロファイル（認証情報を含まない。spec: 名前とホストのみ相当） */
export interface PublicProfile {
  name: string;
  host: string;
  port?: number;
  tls?: boolean;
  ccsid?: number;
  screenSize?: "24x80" | "27x132";
  deviceName?: string;
  autoSignon: boolean;
  /** 自動サインオンのユーザー（プレフィル用。パスワードは露出しない） */
  signonUser?: string;
  /** PDF 自動蓄積・自動印刷（信頼設定）。編集者（認証オフ or admin）にのみ露出する */
  printer?: PrinterConfig;
  /** セッション種別。printer 設定ブロックを持つプロファイルはプリンターセッション用 */
  sessionType: "display" | "printer";
}

/**
 * UI からの編集で受理するフィールド（strict）。`signon`（password/passwordEnc）と `printer`（出力系）は
 * **信頼設定**だが、これらを受理するのは canEditProfiles（認証オフ or admin かつファイル由来）を満たす
 * `/api/profiles` ルート経由のみ——つまり trusted な書き込みに限られる（ルートゲートが境界）。
 * 一般ユーザー・未認証からのリクエストはルートで 403 となり、この入力に到達しない。
 */
const profileInputSchema = z
  .object({
    name: z.string().min(1),
    host: z.string().min(1),
    port: z.number().int().positive().optional(),
    tls: z.boolean().optional(),
    ccsid: z.number().int().optional(),
    screenSize: z.enum(["24x80", "27x132"]).optional(),
    deviceName: z.string().optional(),
    // 種別（新規作成時のみ採用。更新では無視して既存を維持＝種別は不変）
    sessionType: z.enum(["display", "printer"]).optional(),
    // 自動サインオン（UI 設定）。password は平文で受け、サーバーが暗号化して passwordEnc に保存する
    autoSignon: z.boolean().optional(),
    signonUser: z.string().optional(),
    password: z.string().optional(),
    // PDF 自動蓄積・自動印刷（信頼設定・プリンター種別のみ）。canEditProfiles ルート下でのみ到達する
    printer: printerSchema.optional()
  })
  .strict();
export type ProfileInput = z.infer<typeof profileInputSchema>;

/**
 * printer 出力設定の反映規則を正規化する。
 * - input 未指定 → 既存を保持（printer に触れない更新）
 * - input あり → 空文字を除去。意味のあるキーが 1 つも無ければ undefined（＝ブロック削除＝自動蓄積/印刷を無効化）
 */
function buildPrinter(input: PrinterConfig | undefined, keep: PrinterConfig | undefined): PrinterConfig | undefined {
  if (input === undefined) return keep;
  const trimmed = (v?: string): string | undefined => (v !== undefined && v.trim() !== "" ? v.trim() : undefined);
  const out: PrinterConfig = {};
  const autoPdfDir = trimmed(input.autoPdfDir);
  const autoPrint = trimmed(input.autoPrint);
  const pdfFontPath = trimmed(input.pdfFontPath);
  const pdfFontName = trimmed(input.pdfFontName);
  const pageSize = trimmed(input.pageSize);
  if (autoPdfDir !== undefined) out.autoPdfDir = autoPdfDir;
  if (autoPrint !== undefined) out.autoPrint = autoPrint;
  if (pdfFontPath !== undefined) out.pdfFontPath = pdfFontPath;
  if (pdfFontName !== undefined) out.pdfFontName = pdfFontName;
  if (pageSize !== undefined) out.pageSize = pageSize;
  if (input.fontSize !== undefined) out.fontSize = input.fontSize;
  return Object.keys(out).length > 0 ? out : undefined;
}

export class ProfileStore {
  private readonly byName = new Map<string, Profile>();
  private path: string | undefined;

  constructor(
    profiles: Profile[],
    private readonly crypto?: SecretCrypto
  ) {
    for (const p of profiles) this.byName.set(p.name, p);
  }

  static fromFile(path: string, crypto?: SecretCrypto): ProfileStore {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      throw new Tn5250Error("CONNECT_FAILED", `failed to read profiles ${path}: ${(err as Error).message}`);
    }
    // 平文 signon.password は廃止。黙って無視すると自動サインオンが静かに壊れるため、明示エラーで気づける形にする
    const profs = (raw as { profiles?: unknown })?.profiles;
    if (Array.isArray(profs)) {
      for (const p of profs) {
        if (p && typeof p === "object" && (p as { signon?: { password?: unknown } }).signon?.password !== undefined) {
          throw new Tn5250Error(
            "CONNECT_FAILED",
            `profile ${(p as { name?: string }).name ?? "?"}: signon.password (平文) は廃止されました。` +
              `passwordEnv（環境変数）を使うか、UI からパスワードを設定してください（passwordEnc）`
          );
        }
      }
    }
    const parsed = configSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Tn5250Error("CONNECT_FAILED", `invalid profiles.json: ${parsed.error.message}`);
    }
    const store = new ProfileStore(parsed.data.profiles, crypto);
    store.path = path;
    return store;
  }

  /** プロファイルを保存できるか（--profiles でファイル由来のときのみ編集を永続化できる） */
  get persistable(): boolean {
    return this.path !== undefined;
  }

  get(name: string): Profile {
    const p = this.byName.get(name);
    if (!p) throw new Tn5250Error("SESSION_NOT_FOUND", `profile ${name} not found`);
    return p;
  }

  /**
   * API 露出用の一覧（パスワードは含まない）。
   * signon の user 名は既定で伏せる（認証情報として扱う）。編集フォームのプレフィル用に必要なときだけ
   * `includeSignon` で含める——編集は認証オフ or admin に限られるため、一般公開の一覧には出さない。
   */
  listPublic(opts?: { includeSignon?: boolean }): PublicProfile[] {
    return [...this.byName.values()].map((p) => {
      const pub: PublicProfile = {
        name: p.name,
        host: p.host,
        autoSignon: p.signon !== undefined,
        sessionType: effectiveType(p)
      };
      if (p.port !== undefined) pub.port = p.port;
      if (p.tls !== undefined) pub.tls = p.tls;
      if (p.ccsid !== undefined) pub.ccsid = p.ccsid;
      if (p.screenSize !== undefined) pub.screenSize = p.screenSize;
      if (p.deviceName !== undefined) pub.deviceName = p.deviceName;
      // 編集者（認証オフ or admin）にのみ signon user 名・printer 設定を返す（一般公開には出さない）
      if (opts?.includeSignon) {
        if (p.signon?.user !== undefined) pub.signonUser = p.signon.user;
        if (p.printer !== undefined) pub.printer = p.printer;
      }
      return pub;
    });
  }

  /**
   * 接続フィールドから Profile 本体を組み立てる。enhanced は保持。
   * signon/printer は UI 編集を反映する（未指定=既存保持 / 空=クリア / 値=置換）。この入力は canEditProfiles
   * ルート下でのみ到達するため、trusted な編集に限られる。
   */
  private buildProfile(input: ProfileInput, keep?: Profile): Profile {
    // 種別: 新規は入力（既定 display）、更新は既存を維持（不変）
    const type: "display" | "printer" = keep ? effectiveType(keep) : (input.sessionType ?? "display");
    const p: Profile = { name: input.name, host: input.host, sessionType: type };
    if (input.port !== undefined) p.port = input.port;
    if (input.tls !== undefined) p.tls = input.tls;
    if (input.ccsid !== undefined) p.ccsid = input.ccsid;
    if (input.screenSize !== undefined) p.screenSize = input.screenSize;
    if (input.deviceName !== undefined) p.deviceName = input.deviceName;
    if (keep?.enhanced !== undefined) p.enhanced = keep.enhanced;
    // printer 出力はプリンター種別のときのみ（display では常に落とす＝信頼設定の混入防止）
    const printer = type === "printer" ? buildPrinter(input.printer, keep?.printer) : undefined;
    if (printer) p.printer = printer;
    const signon = this.buildSignon(input, keep?.signon);
    if (signon) p.signon = signon;
    return p;
  }

  /** signon の再構築（UI の autoSignon/user/password を反映しつつ既存パスワード機構を保持） */
  private buildSignon(input: ProfileInput, keep?: Profile["signon"]): Profile["signon"] | undefined {
    if (input.autoSignon === undefined) return keep; // 未指定＝既存を保持（signon に触れない更新）
    if (!input.autoSignon) return undefined; // 明示オフ＝自動サインオンを解除
    const user = input.signonUser ?? keep?.user;
    if (!user) return undefined; // ユーザー未指定なら signon を作らない
    const signon: NonNullable<Profile["signon"]> = { user };
    if (input.password !== undefined && input.password !== "") {
      if (!this.crypto) throw new Tn5250Error("CONFIG_ERROR", "secret key not configured; cannot store password");
      signon.passwordEnc = this.crypto.encrypt(input.password);
    } else {
      // パスワード未指定: 既存の機構を保持（passwordEnc 優先→passwordEnv）
      if (keep?.passwordEnc !== undefined) signon.passwordEnc = keep.passwordEnc;
      else if (keep?.passwordEnv !== undefined) signon.passwordEnv = keep.passwordEnv;
    }
    return signon;
  }

  /** 新規プロファイルを追加（接続フィールドのみ。信頼設定は持たない）。同名は FORBIDDEN */
  add(inputRaw: unknown): PublicProfile {
    const input = profileInputSchema.parse(inputRaw);
    if (this.byName.has(input.name)) {
      throw new Tn5250Error("FORBIDDEN", `profile ${input.name} already exists`);
    }
    this.byName.set(input.name, this.buildProfile(input));
    return this.publicOf(input.name);
  }

  /** 既存プロファイルを更新（接続フィールドのみ。signon/printer は保持）。name 変更は改名として扱う */
  update(name: string, inputRaw: unknown): PublicProfile {
    const existing = this.get(name);
    const input = profileInputSchema.parse(inputRaw);
    if (input.name !== name && this.byName.has(input.name)) {
      throw new Tn5250Error("FORBIDDEN", `profile ${input.name} already exists`);
    }
    const updated = this.buildProfile(input, existing);
    if (input.name !== name) this.byName.delete(name); // 改名
    this.byName.set(input.name, updated);
    return this.publicOf(input.name);
  }

  remove(name: string): void {
    if (!this.byName.delete(name)) throw new Tn5250Error("SESSION_NOT_FOUND", `profile ${name} not found`);
  }

  /** 所有移動用: 生 Profile を取得（存在必須） */
  getRaw(name: string): Profile {
    return this.get(name);
  }

  /** 所有移動用: 完成済み Profile を追加（同名は FORBIDDEN）。サーバー内専用 */
  addRecord(p: Profile): PublicProfile {
    if (this.byName.has(p.name)) throw new Tn5250Error("FORBIDDEN", `profile ${p.name} already exists`);
    this.byName.set(p.name, p);
    return this.publicOf(p.name);
  }

  /** 単一プロファイルの公開表現（listPublic と同じ整形） */
  private publicOf(name: string): PublicProfile {
    const found = this.listPublic().find((p) => p.name === name);
    if (!found) throw new Tn5250Error("SESSION_NOT_FOUND", `profile ${name} not found`);
    return found;
  }

  /** profiles.json へ原子的に保存（tmp→rename）。ファイル由来のときのみ */
  async save(): Promise<void> {
    if (!this.path) return;
    const json = JSON.stringify({ profiles: [...this.byName.values()] }, null, 2);
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, json, "utf8");
    await rename(tmp, this.path);
  }

  /**
   * プロファイルを core の ConnectOptions に解決する（passwordEnv → 実際のパスワード）。
   * signon があれば RFC 4777 自動サインオン（user/password）を設定する（D3）。
   * 認証情報はここで解決してサーバー内に留め、外へ返さない（D13）。
   */
  resolveConnectOptions(name: string, warn?: (msg: string) => void): ConnectOptions {
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
      const s = p.signon;
      let password: string | undefined;
      if (s.passwordEnc !== undefined) {
        // UI 設定の暗号化パスワード。復号失敗（鍵未設定/鍵変更）は自動サインオンなしで続行
        if (this.crypto) {
          try {
            password = this.crypto.decrypt(s.passwordEnc);
          } catch {
            warn?.(`profile ${name}: failed to decrypt saved password (auto-signon skipped)`);
          }
        } else {
          warn?.(`profile ${name}: secret key not configured (auto-signon skipped)`);
        }
      } else if (s.passwordEnv !== undefined) {
        // 運用者管理の env 参照。設定漏れは明示エラー（気づける形にする）
        password = process.env[s.passwordEnv];
        if (password === undefined || password === "") {
          throw new Tn5250Error(
            "CONNECT_FAILED",
            `profile ${name}: password not available (env ${s.passwordEnv} unset)`
          );
        }
      }
      // signon.user のみで password 機構が無い場合は自動サインオンせず signon 画面に着地する
      if (password !== undefined && password !== "") {
        opts.user = s.user;
        opts.password = password;
      }
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
