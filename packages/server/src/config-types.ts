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
/**
 * セッション種別。
 *
 * `dtaqwatch` は**サービス型**——人が画面を触るのではなく、設定が仕事をする
 * （データ待ち行列を常駐監視する）。装置名も画面サイズも使わない
 * （`20260723-dtaq-watch-notify` spec 方針1・research F5）。
 */
export const sessionTypeSchema = z.enum(["display", "printer", "dtaqwatch"]);

/**
 * **開いた直後／サーバー起動直後に待ち受けを開始するか**（既定 true）。
 *
 * 「自動起動」ではなく「**自動で待ち受けを開始する**」。セッションの場合、
 * セッション自体は開かれている（起動している）——自動なのは待ち受けの開始の方。
 *
 * 1 つの設定が 2 つの文脈で同じ意味になる:
 * - サービス: **サーバー起動時**に待ち受けを開始する
 * - セッション: **開いた直後**に待ち受けを開始する
 *
 * **既定を true にするのは、いまある定義の挙動を変えないため**——
 * false を既定にすると、アップグレードで「開いても何も起きない」に変わる（design D3）。
 */
export const autoStartSchema = z.boolean().optional();

/**
 * 常駐監視するデータ待ち行列の指定。
 *
 * **信頼設定ではない**——サーバー上のパス書き込み・コマンド実行・秘密のいずれにも触れないので、
 * サーバー設定・個人設定の両方が持てる（`watermark` と同じ理屈）。
 *
 * **監視はエントリを取り出して消す**（本番のコンシューマの取り分を奪う）。
 * その注意は UI 側で常時出す（`opMessages.ts` の `MSG_WATCH_CONSUMES`）。
 */
export const dtaqWatchSchema = z
  .object({
    /** ライブラリー名（EBCDIC 10 バイト固定） */
    library: z.string().min(1).max(10),
    /** キュー名（同上） */
    name: z.string().min(1).max(10),
    /** 本文の符号化（既定 utf8）。`ebcdic` はシステム CCSID のキュー */
    encoding: z.enum(["utf8", "base64", "ebcdic"]).optional(),
    /** キー付きキューのキー。`search` と対で意味を持つ */
    key: z.string().optional(),
    search: z.enum(["EQ", "NE", "LT", "LE", "GT", "GE"]).optional()
  })
  .strict();
export type SessionType = z.infer<typeof sessionTypeSchema>;
export type DtaqWatchSpec = z.infer<typeof dtaqWatchSchema>;

/** プリンターセッションのサーバー側出力設定（PDF 自動蓄積・自動印刷）。**信頼設定** */
export const printerSchema = z.object({
  /**
   * **サービスとして利用する。** WS が切れても待ち受けを止めない（常駐する）。
   *
   * **意図であって能力ではない**——出力設定（`autoPdfDir` / `autoPrint`）の有無から
   * 導出しない。導出すると「開いている間だけ PDF に落としたい」も
   * 「常駐して溜めるだけ」も表現できなくなる
   * （`20260801-printer-session-residency` の作り直し。design D3）。
   *
   * この設定を持てるのは printer スキーマ＝**サーバー設定側だけ**なので、
   * admin 限定という制約は既存の信頼境界にそのまま乗る。
   */
  service: z.boolean().optional(),
  autoPdfDir: z.string().optional(),
  autoPrint: z.string().optional(),
  pdfFontPath: z.string().optional(),
  pdfFontName: z.string().optional(),
  pageSize: z.string().optional(),
  fontSize: z.number().positive().optional()
});
export type PrinterConfig = z.infer<typeof printerSchema>;

/**
 * PC Organizer（`STRPCCMD`）でホストから届いたコマンドの実行設定。**信頼設定**。
 *
 * `printer` と同じ理由でサーバー設定のセッションにしか持たせない——
 * こちらはサーバー機での**任意コマンド実行**そのもので、`autoPdfDir` より強い権限にあたる。
 * 既定は無効（`enabled` 省略＝false）で、明示的に入れたときだけ動く。
 */
export const pcCommandSchema = z
  .object({
    enabled: z.boolean().optional(),
    /** PAUSE(*YES) で待つ上限（ミリ秒）。既定 60 秒。1 時間を超える指定は受けない */
    timeoutMs: z.number().int().positive().max(3_600_000).optional(),
    cwd: z.string().optional(),
    /** 許可する正規表現（全体一致）。空配列は「制限なし」と紛らわしいので受けない */
    allow: z.array(z.string().min(1)).nonempty().optional()
  })
  .strict();
export type PcCommandSettings = z.infer<typeof pcCommandSchema>;

/**
 * ウォーターマーク（画面に重ねる透かし）。ACS の透かしと同じ用途——
 * **本番機と検証機を一目で見分ける**ために、画面全体へ薄く文字を敷く。
 *
 * **信頼設定ではない**（サーバー上のパス書き込み・コマンド実行・秘密のいずれにも触れず、
 * 描くのは要求元のブラウザだけ）。したがって個人設定にも持たせる＝`sessionBase` に置く。
 * ホストへは一切送らない（`ConnectOptions` に写さない）表示だけの設定である。
 */
export const watermarkSchema = z
  .object({
    /** 透かしの文字。`{host}` 等の差し込み変数を含められる（展開はブラウザ側） */
    text: z.string().min(1).max(120),
    /** 表示するか（既定 true）。**文字を消さずに切れる**ようにするための独立したスイッチ */
    enabled: z.boolean().optional(),
    /** 濃さ（0.02〜1）。既定はブラウザ側の WATERMARK_DEFAULTS */
    opacity: z.number().min(0.02).max(1).optional(),
    /** 文字の大きさ（px） */
    size: z.number().int().min(8).max(200).optional(),
    /** 敷き方: `tile`＝画面全体に並べる / `center`＝中央に 1 つ */
    layout: z.enum(["tile", "center"]).optional(),
    /** 回転角（度。-90〜90） */
    angle: z.number().int().min(-90).max(90).optional(),
    /**
     * 色（`#rrggbb`）。省略時は端末の前景色（`--t-white`）に追従する。
     *
     * **書式を正規表現で縛るのは意図的**——この値はブラウザで CSS の色としてそのまま使われる。
     * 任意の文字列を通すと `red; background: url(...)` のように別の宣言を混ぜられる。
     */
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/, "color must be #rrggbb")
      .optional()
  })
  .strict();
export type Watermark = z.infer<typeof watermarkSchema>;

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

/**
 * 無操作で切るまでの時間。`"never"`＝切らない（永続）/ 数値＝**分**（1〜1440）。
 * 未設定はサーバー既定（`--idle-timeout`。既定は永続）に従う。
 *
 * **`0` も `null` も「切らない」の印にしない。** 未設定・転記漏れと見分けが付かなくなる。
 * 三者（未設定 / 永続 / 有限）を型で分けておくのが要点（spec 方針2）。
 */
export const idleTimeoutSchema = z.union([z.literal("never"), z.number().int().min(1).max(1440)]);
export type IdleTimeout = z.infer<typeof idleTimeoutSchema>;

/**
 * 設定値（分 or `"never"`）を `SessionManager` の内部表現（ms or `"never"`）へ変換する。
 * 未設定は `undefined` のまま返す——**マネージャ既定に従う**という意味を潰さないため。
 */
export function idleTimeoutToMs(v: IdleTimeout | undefined): number | "never" | undefined {
  if (v === undefined) return undefined;
  return v === "never" ? "never" : v * 60_000;
}

/** システム / セッションに共通の「どう使うか」 */
const sessionBase = {
  id: z.string().min(1),
  name: z.string().min(1),
  /** 同一ファイル内のシステム id。ファイル外は参照できない */
  system: z.string().min(1),
  sessionType: sessionTypeSchema,
  /**
   * 開いた直後／サーバー起動直後に**待ち受けを開始するか**（既定 true）。
   * `printer` と `dtaqwatch` にだけ意味がある（`display` は画面なので常に開く）。
   */
  autoStart: autoStartSchema,
  deviceName: z.string().optional(),
  /**
   * 装置名が使用中でホストに拒否されたとき、末尾の数字を繰り上げて再試行する（既定 false）。
   * 装置名を固定するのは「その名前で繋ぎたい」意図なので、既定では別名にすり替えない。
   */
  deviceNameRetry: z.boolean().optional(),
  /**
   * 書き出しできないスプールを取得したあと、ホスト側のスプールをどうするか（printer のみ）。
   * `hold`（既定）＝保留にして残す / `delete`＝削除する。削除は取り消せない。
   */
  rescueAction: z.enum(["hold", "delete"]).optional(),
  /**
   * printer のみ。ホスト側で印刷データへ変換させる機種（"*HP4" 等。HPT）。
   *
   * 指定すると**本来の印刷経路**になる——ホストが決めた書式のまま実プリンターへ流せる。
   * 代わりに届くのが SCS でなくなるので、画面表示と PDF は使えない。
   * 未指定（既定）は従来どおり SCS を受け取り、表示・PDF ができる。
   */
  transformTo: z.string().min(1).optional(),
  /** display のみ意味を持つ */
  screenSize: screenSizeSchema.optional(),
  /** システムの既定 CCSID を上書きする */
  ccsid: z.number().int().optional(),
  /** display のみ意味を持つ */
  enhanced: z.boolean().optional(),
  /** display のみ意味を持つ。画面に重ねる透かし（表示だけの設定） */
  watermark: watermarkSchema.optional(),
  /**
   * `dtaqwatch` のみ。常駐監視するデータ待ち行列。
   * **種別との整合は parse で強制する**（下記 `assertTypeConsistent`）。
   */
  dtaqWatch: dtaqWatchSchema.optional(),
  /**
   * 無操作で切るまでの時間（display / printer 双方で意味を持つ）。
   *
   * **信頼設定ではない**——サーバー上のパス書き込み・コマンド実行・秘密のいずれにも触れないので、
   * `watermark` と同じ理屈でサーバー設定・個人設定の両方が持てる。
   */
  idleTimeout: idleTimeoutSchema.optional()
};

/**
 * サーバー設定のセッション（profiles.json）。printer 出力と PC コマンド実行を持てる。
 * 到達経路は `canEditProfiles`（認証オフ or admin かつファイル永続化可）のルートに限られる。
 */
/**
 * **種別と設定の整合を parse で強制する。**
 *
 * 片方だけ書ける状態にすると「監視のつもりで登録したのに何も起きない」設定が作れてしまう
 * （`dtaqwatch` なのに対象キューが無い／`display` なのに監視設定がある）。
 * 後段で落とす形にせず、**受け取った時点で 400 にする**（`printer` を個人設定に
 * 持たせない判断と同じ考え方）。
 */
function assertTypeConsistent(
  s: { sessionType: SessionType; dtaqWatch?: DtaqWatchSpec | undefined },
  ctx: z.RefinementCtx
): void {
  if (s.sessionType === "dtaqwatch" && s.dtaqWatch === undefined) {
    ctx.addIssue({ code: "custom", path: ["dtaqWatch"], message: "dtaqwatch セッションには dtaqWatch が必要です" });
  }
  if (s.sessionType !== "dtaqwatch" && s.dtaqWatch !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["dtaqWatch"],
      message: `dtaqWatch は dtaqwatch セッションにしか指定できません（sessionType=${s.sessionType}）`
    });
  }
}

/**
 * **素のオブジェクト版**（`superRefine` を付ける前）。
 *
 * `.superRefine()` を付けると `ZodEffects` になり **`.omit()` が使えなくなる**。
 * `ConfigStore.parseSessionInput` は `id` を除いて検証するため `.omit()` が必要なので、
 * 素の版も公開して、整合チェックは呼び出し側で重ねてかける（`sessionInputSchema`）。
 */
export const serverSessionObject = z
  .object({ ...sessionBase, printer: printerSchema.optional(), pcCommand: pcCommandSchema.optional() })
  .strict();
export const serverSessionSchema = serverSessionObject.superRefine(assertTypeConsistent);
export type ServerSession = z.infer<typeof serverSessionSchema>;

/**
 * 個人設定のセッション（connections.json）。
 * **`printer` も `pcCommand` も持たない**——ここが信頼境界の 1 層目。`.strict()` により、
 * 送られてきた時点で parse が失敗する（400）。**optional にして後段で落とす形にしてはならない。**
 */
/** 素のオブジェクト版（理由は `serverSessionObject` の JSDoc） */
export const personalSessionObject = z
  .object({ ...sessionBase, owner: z.string().optional() })
  .strict();
export const personalSessionSchema = personalSessionObject.superRefine(assertTypeConsistent);
export type PersonalSession = z.infer<typeof personalSessionSchema>;

/**
 * CRUD の入力用スキーマ（`id` はサーバーが採番するので除く）。
 * **整合チェックはここでも掛ける**——ファイル読み込みだけで守ると、
 * API 経由で `dtaqwatch` なのに対象キューが無い設定を作れてしまう。
 */
export function sessionInputSchema(
  source: ConfigSource
): z.ZodType<Omit<ServerSession, "id"> | Omit<PersonalSession, "id">> {
  const obj =
    source === "server"
      ? serverSessionObject.omit({ id: true })
      : personalSessionObject.omit({ id: true });
  return obj.superRefine(assertTypeConsistent) as unknown as z.ZodType<
    Omit<ServerSession, "id"> | Omit<PersonalSession, "id">
  >;
}

/** 保管場所を問わず読める共通部分（解決器が扱う形） */
export type AnySession = ServerSession | PersonalSession;

export function sessionPrinter(s: AnySession): PrinterConfig | undefined {
  return "printer" in s ? s.printer : undefined;
}

/**
 * 監視の設定を取り出す。**種別が `dtaqwatch` のときだけ**返す——
 * 種別と設定の整合は parse で強制しているが、読み出し側でも種別を見ておく
 * （古いファイルを直接編集された場合に、意図しない監視を始めないため）。
 */
export function sessionDtaqWatch(s: AnySession): DtaqWatchSpec | undefined {
  return s.sessionType === "dtaqwatch" ? s.dtaqWatch : undefined;
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
  sessionType: SessionType;
  deviceName?: string;
  /** printer のみ。書き出しできないスプールを取得したあとの扱い（既定 hold） */
  rescueAction?: "hold" | "delete";
  /** printer のみ。ホスト変換の機種（HPT）。指定時は表示・PDF が使えない代わりに本来の印刷になる */
  transformTo?: string;
  screenSize?: "24x80" | "27x132";
  ccsid?: number;
  enhanced?: boolean;
  /** display のみ。画面に重ねる透かし（描くのはブラウザ。信頼設定ではない） */
  watermark?: Watermark;
  /** 無操作で切るまでの時間。`"never"`＝切らない / 数値＝分。未設定はサーバー既定に従う */
  idleTimeout?: IdleTimeout;
  /** `dtaqwatch` のみ。常駐監視するデータ待ち行列（信頼設定ではないので値ごと返す） */
  dtaqWatch?: DtaqWatchSpec;
  /**
   * PC コマンド（STRPCCMD）の実行設定。**編集できる相手にだけ返す**（`includeTrusted`）。
   *
   * 秘密ではないので値ごと返す。返さないと編集フォームが空から始まり、
   * 保存のたびに許可パターンが黙って消える——**設定の消失が安全側に倒れない**
   * （`enabled` だけ残って `allow` が消えると、むしろ緩くなる）。
   */
  pcCommand?: PcCommandSettings;
  owner?: string;
}
