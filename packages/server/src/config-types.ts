/**
 * 接続設定の型（システム / セッション設定の 2 階層）。
 *
 * 2 軸で整理する:
 *   - **保管場所**: サーバー設定（profiles.json・admin 専用）/ 個人設定（connections.json・所有者のみ）
 *   - **階層**: システム（どこへ・誰として）/ セッション設定（どう使うか）
 *
 * **セッションスキーマを 2 本立てにしているのは信頼境界のため**（design の判断）。
 * printer 出力（`autoPdfDir` 等）はサーバー上の任意パスへのファイル書き込みに直結する
 * （printer-output.ts が設定値をそのまま `join` に渡す）。共通スキーマ 1 本にして
 * `printer` を optional にすると個人設定でも通ってしまうため、**個人側の型にそもそも持たせない**。
 */
import { z } from "zod";

export const screenSizeSchema = z.enum(["24x80", "27x132"]);
export const sessionTypeSchema = z.enum(["display", "printer"]);

/** プリンターセッションのサーバー側出力設定（PDF 自動蓄積・自動印刷）。**信頼設定** */
export const printerSchema = z.object({
  autoPdfDir: z.string().optional(),
  autoPrint: z.string().optional(),
  pdfFontPath: z.string().optional(),
  pdfFontName: z.string().optional(),
  pageSize: z.string().optional(),
  fontSize: z.number().positive().optional()
});
export type PrinterConfig = z.infer<typeof printerSchema>;

/** 自動サインオンの資格情報。**システムだけが持つ**（セッション設定は持たない） */
export const signonSchema = z
  .object({
    user: z.string().min(1),
    /** パスワードを保持する環境変数名（運用者向け・env 注入）。サーバー設定のみ */
    passwordEnv: z.string().min(1).optional(),
    /** 暗号化パスワード（AES-256-GCM の `v1:iv:tag:ct`）。passwordEnv より優先 */
    passwordEnc: z.string().optional()
  })
  .strict();
export type Signon = z.infer<typeof signonSchema>;

/** システム = 接続先 + 資格情報 + 既定 CCSID。セッション設定の親 */
export const systemSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    host: z.string().min(1),
    port: z.number().int().positive().optional(),
    tls: z.boolean().optional(),
    /** 既定 CCSID。セッション設定が上書きできる */
    ccsid: z.number().int().optional(),
    /**
     * スプール（SCS）のデコードに使う CCSID。既定 273。
     *
     * 上の `ccsid` とは**別物**——あちらは 5250 画面の文字変換用で、経路によって扱いが違う
     * （`host-connect.ts` の openNetPrint / spec 方針2。`20260718-hostserver-spool` の決定）。
     * セッション階層には置かない: pull 型スプールはセッションに紐づかないため（spec 方針2）。
     */
    spoolCcsid: z.number().int().optional(),
    /** 個人設定のみ。サーバー設定は所有者を持たない */
    owner: z.string().optional(),
    signon: signonSchema.optional()
  })
  .strict();
export type System = z.infer<typeof systemSchema>;

/** システム / セッションに共通の「どう使うか」 */
const sessionBase = {
  id: z.string().min(1),
  name: z.string().min(1),
  /** 同一ファイル内のシステム id。ファイル外は参照できない */
  system: z.string().min(1),
  sessionType: sessionTypeSchema,
  deviceName: z.string().optional(),
  /** display のみ意味を持つ */
  screenSize: screenSizeSchema.optional(),
  /** システムの既定 CCSID を上書きする */
  ccsid: z.number().int().optional(),
  /** display のみ意味を持つ */
  enhanced: z.boolean().optional()
};

/**
 * サーバー設定のセッション（profiles.json）。printer 出力を持てる。
 * 到達経路は `canEditProfiles`（認証オフ or admin かつファイル永続化可）のルートに限られる。
 */
export const serverSessionSchema = z
  .object({ ...sessionBase, printer: printerSchema.optional() })
  .strict();
export type ServerSession = z.infer<typeof serverSessionSchema>;

/**
 * 個人設定のセッション（connections.json）。
 * **`printer` を持たない**——ここが信頼境界の 1 層目。`.strict()` により、
 * 送られてきた時点で parse が失敗する（400）。**optional にして後段で落とす形にしてはならない。**
 */
export const personalSessionSchema = z
  .object({ ...sessionBase, owner: z.string().optional() })
  .strict();
export type PersonalSession = z.infer<typeof personalSessionSchema>;

/** 保管場所を問わず読める共通部分（解決器が扱う形） */
export type AnySession = ServerSession | PersonalSession;

export function sessionPrinter(s: AnySession): PrinterConfig | undefined {
  return "printer" in s ? s.printer : undefined;
}

/** ファイル全体 */
export const serverConfigSchema = z
  .object({
    systems: z.array(systemSchema),
    sessions: z.array(serverSessionSchema)
  })
  .strict();
export type ServerConfig = z.infer<typeof serverConfigSchema>;

export const personalConfigSchema = z
  .object({
    systems: z.array(systemSchema),
    sessions: z.array(personalSessionSchema)
  })
  .strict();
export type PersonalConfig = z.infer<typeof personalConfigSchema>;

/** 参照トークンの接頭辞。接頭辞なしは受け付けない（曖昧な解決をしない） */
export const REF_PREFIX = { server: "srv:", personal: "own:" } as const;
export type ConfigSource = "server" | "personal";

export interface ParsedRef {
  source: ConfigSource;
  id: string;
}

/** `srv:<name>` / `own:<id>` を分解する。接頭辞が無い・未知なら undefined */
export function parseRef(ref: string): ParsedRef | undefined {
  if (ref.startsWith(REF_PREFIX.server)) {
    const id = ref.slice(REF_PREFIX.server.length);
    return id ? { source: "server", id } : undefined;
  }
  if (ref.startsWith(REF_PREFIX.personal)) {
    const id = ref.slice(REF_PREFIX.personal.length);
    return id ? { source: "personal", id } : undefined;
  }
  return undefined;
}

export function makeRef(source: ConfigSource, id: string): string {
  return `${REF_PREFIX[source]}${id}`;
}

/** API 露出用のシステム（**資格情報を返さない**。有無だけ真偽値で示す） */
export interface PublicSystem {
  ref: string;
  name: string;
  host: string;
  port?: number;
  tls?: boolean;
  ccsid?: number;
  /** スプール（SCS）用 CCSID。5250 画面用の `ccsid` とは別（spec 方針2） */
  spoolCcsid?: number;
  owner?: string;
  /** 資格情報が設定されているか */
  autoSignon: boolean;
  /**
   * 自動サインオンのユーザー名。**編集フォームのプレフィル用にだけ返す**（`includeSignon`）。
   * 機械向けの一覧（MCP）には出さない。パスワードは形式を問わず決して返さない。
   */
  signonUser?: string;
}

/** API 露出用のセッション設定（**printer 出力を返さない**） */
export interface PublicSession {
  ref: string;
  name: string;
  system: string;
  sessionType: "display" | "printer";
  deviceName?: string;
  screenSize?: "24x80" | "27x132";
  ccsid?: number;
  enhanced?: boolean;
  owner?: string;
}
