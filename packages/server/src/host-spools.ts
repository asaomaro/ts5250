/**
 * pull 型スプールの取得（一覧・本文・PDF）。
 *
 * **push 型（`PrinterSession`）とは別系統**——あちらはプリンターセッションを開いている間に
 * 受信した帳票だけを持ち、過去のスプールは取れない（`/api/spool/:sessionId/...`）。
 * こちらは任意の出力待ち行列から**既存の**スプールを検索・取得する。
 *
 * **接続種別が用途で違う**のがこのモジュールの肝:
 *   - 一覧 → コマンドサーバー（`openCommand`）
 *   - 本文 → ネットワーク印刷サーバー（`openNetPrint`）
 *
 * 共有関数（`listSpools` / `readSpoolPages`）を **HTTP ルートと MCP ツールの唯一の経路**にしている
 * （`host-upload.ts` と同じ方針。spec 方針1）。ロジックを二重に持つと、片方だけ直す事故が起きる。
 *
 * 監査は行わない——既存のホストサーバー系 HTTP ルート（host-lists / host-sql / host-upload）に
 * 倣う（spec 方針3）。HTTP 全体への監査導入は別課題。
 */
import { Hono } from "hono";
import { z } from "zod";
import {
  As400Error,
  listSpooledFiles,
  type ConnectOptions,
  type LogicalPage,
  type SpoolEntry,
  type SpoolId,
  type SpoolListFilter
} from "@as400web/core";
import type { AuthVars } from "./auth.js";
import type { ConfigResolver } from "./config-resolver.js";
import { openCommand, openNetPrint } from "./host-connect.js";
import { compact, resolveSource, sourceSchema, statusOf } from "./host-api.js";
import { renderSpoolPdf } from "./pdf.js";
import { childLog } from "./log.js";

const log = childLog({ component: "host-spools" });

/** 一覧の既定件数。スプールは 1 件が重いので、他の一覧（200）より控えめにする */
export const DEFAULT_SPOOLS = 100;
/** 一覧の上限。host-sql の MAX_ROWS と同じ水準に揃える */
export const MAX_SPOOLS = 1000;
/** SCS デコードの既定 CCSID。`openNetPrint` の既定と揃える（5250 側の 37 とは別） */
export const DEFAULT_SPOOL_CCSID = 273;

export interface SpoolListPage {
  items: SpoolEntry[];
  /**
   * `max` で切られたか。UI は「先頭 N 件のみ表示」と断る。
   *
   * **総件数は返せない**——QGYOLSPL のリスト情報にある `total` は名前に反して
   * 「返した件数」と同値で、一致総数ではない（実機で確認。core の LIST_INFO のコメント参照）。
   * そのため「1234 件中 100 件」のような言い方はできない。
   */
  truncated: boolean;
}

/**
 * スプールを一覧する（コマンドサーバー経由）。
 *
 * 見える範囲は**資格情報の権限が決める**——一般ユーザーは自分のスプールのみ。
 * これは制約であって不具合ではないので、アプリ側で追加の制限は掛けない。
 */
export async function listSpools(
  opts: ConnectOptions,
  filter: SpoolListFilter,
  max: number
): Promise<SpoolListPage> {
  assertMax(max);
  const conn = await openCommand(opts);
  try {
    // **1 件多く要求して打ち切りを検出する**（host-sql.ts:219 と同じ考え方）。
    // ホスト側の「総件数」は当てにできない——LIST_INFO.total は返した件数と同値で、
    // それを信じると truncated が常に false になり「全件見た」と誤解させる（実機で判明）
    const entries = await listSpooledFiles(conn, filter, { max: max + 1 });
    const truncated = entries.length > max;
    return { items: truncated ? entries.slice(0, max) : entries, truncated };
  } finally {
    conn.close();
  }
}

/**
 * スプールの中身を論理ページとして読む（ネットワーク印刷サーバー経由）。
 *
 * PDF もテキストもここを通る——`renderSpoolPdf` が受け取る `LogicalPage[]` は
 * push 型と共通の型で、同じ `ScsDecoder` の出力なので**変換なしでそのまま渡せる**。
 */
export async function readSpoolPages(
  opts: ConnectOptions,
  id: SpoolId,
  ccsid?: number
): Promise<LogicalPage[]> {
  const conn = await openNetPrint(opts, ccsid ?? opts.spoolCcsid ?? DEFAULT_SPOOL_CCSID);
  try {
    return await conn.readSpooledPages(id);
  } finally {
    conn.close();
  }
}

/**
 * 上限検査。
 *
 * HTTP と MCP はそれぞれ独自の zod スキーマで `max` を検証しており、この関数に来る前に
 * 弾かれる。それでもここで検査するのは、**`listSpools` が export されていて
 * どこからでも呼べる**ため——2 つのスキーマが将来ずれても、上限はこの 1 か所で守れる。
 * （`host-upload.ts` は「MCP は zod を通らない」と書いているが、
 *  `registerTool` は `inputSchema` を検証するので、その理由は成り立たない）
 */
function assertMax(max: number): void {
  if (!Number.isInteger(max) || max < 1 || max > MAX_SPOOLS) {
    throw new As400Error("CONFIG_ERROR", `max は 1〜${MAX_SPOOLS} で指定してください（指定値: ${max}）`);
  }
}

/**
 * ファイル名に使えない文字を落とす。
 * `Content-Disposition` へ生のまま埋めるとヘッダを壊せる（既存の
 * `/api/spool/:sessionId/:spoolId/pdf` はエスケープしていない。同じ粗さを繰り返さない）。
 */
function safeFileName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64);
  return cleaned.length > 0 ? cleaned : "spool";
}

// ---- HTTP ----

const spoolIdSchema = z
  .object({
    jobName: z.string().min(1),
    jobUser: z.string().min(1),
    jobNumber: z.string().min(1),
    fileName: z.string().min(1),
    fileNumber: z.number().int()
  })
  .strict();

const spoolFilterSchema = z
  .object({
    user: z.string().optional(),
    outputQueue: z.string().optional(),
    outputQueueLibrary: z.string().optional(),
    status: z.string().optional(),
    formType: z.string().optional(),
    userData: z.string().optional()
  })
  .strict();

const listRequestSchema = z
  .object({
    source: sourceSchema,
    filter: spoolFilterSchema.optional(),
    max: z.number().int().positive().max(MAX_SPOOLS).optional()
  })
  .strict();

const contentRequestSchema = z
  .object({ source: sourceSchema, id: spoolIdSchema })
  .strict();

export interface HostSpoolDeps {
  resolver: ConfigResolver;
}

export function registerHostSpoolRoutes(
  app: Hono<{ Variables: AuthVars }>,
  deps: HostSpoolDeps
): void {
  /** 一覧（コマンドサーバー） */
  app.post("/api/host/spools", async (c) => {
    const parsed = listRequestSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message ?? "invalid request" }, 400);
    }
    const body = parsed.data;
    try {
      const opts = resolveSource(deps.resolver, body.source, c.get("user"));
      const page = await listSpools(opts, compact(body.filter), body.max ?? DEFAULT_SPOOLS);
      return c.json({
        items: page.items,
        count: page.items.length,
        truncated: page.truncated
      });
    } catch (e) {
      const err = e as As400Error;
      return c.json({ error: err.message, code: err.code ?? "UNKNOWN" }, statusOf(err));
    }
  });

  /**
   * 本文（ネットワーク印刷サーバー）。
   * ページ区切りを保ったまま返す——クライアントが改ページを描けるようにするため。
   */
  app.post("/api/host/spool/content", async (c) => {
    const parsed = contentRequestSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message ?? "invalid request" }, 400);
    }
    const body = parsed.data;
    try {
      const opts = resolveSource(deps.resolver, body.source, c.get("user"));
      const pages = await readSpoolPages(opts, body.id);
      return c.json({ pages });
    } catch (e) {
      const err = e as As400Error;
      return c.json({ error: err.message, code: err.code ?? "UNKNOWN" }, statusOf(err));
    }
  });

  /**
   * PDF。**GET ではなく POST**——スプールの識別子は 5 要素の複合キーで、URL に載せると
   * エスケープの都合が増える。クライアントは fetch → blob でダウンロードする。
   */
  app.post("/api/host/spool/pdf", async (c) => {
    const parsed = contentRequestSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message ?? "invalid request" }, 400);
    }
    const body = parsed.data;
    try {
      const opts = resolveSource(deps.resolver, body.source, c.get("user"));
      const pages = await readSpoolPages(opts, body.id);
      // フォントを読めないと DBCS が化ける。**エラーにはならない**ので必ずログに残す
      const pdf = await renderSpoolPdf(pages, {}, (m) => log.warn(m));
      const name = safeFileName(`${body.id.fileName}-${body.id.jobName}-${body.id.fileNumber}`);
      return new Response(new Uint8Array(pdf), {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="${name}.pdf"`
        }
      });
    } catch (e) {
      const err = e as As400Error;
      return c.json({ error: err.message, code: err.code ?? "UNKNOWN" }, statusOf(err));
    }
  });
}
