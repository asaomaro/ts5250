/**
 * データ待ち行列（DTAQ）の HTTP ルート。
 *
 * 認可は他のホスト API と揃える——`c.get("user")` を `resolveSource()` に渡すだけで、
 * 実際に何を送受信できるかは IBM i 側の権限が決める。
 * 接続は要求ごとに開いて閉じる（`host-connect.ts` の規約）。
 *
 * **core は生バイトを扱い、テキスト⇄バイトの変換はここ（server）に置く**（spec の方針）。
 * `data`/`key` は `encoding` で解釈する: `utf8`（テキスト）/ `base64`（バイナリ）/
 * `ebcdic`（システム CCSID のキュー）。
 */
import type { Context, Hono } from "hono";
import { z } from "zod";
import type { DtaqConnection, DtaqSearchOrder } from "@as400web/core";
import { As400Error, dtaqDecodeEbcdic } from "@as400web/core";
import { codecForCcsid } from "@as400web/core/codec";
import type { AuthVars } from "./auth.js";
import type { ConfigResolver } from "./config-resolver.js";
import { openDtaq } from "./host-connect.js";
import { sourceSchema, statusOf, resolveSource } from "./host-api.js";
import { childLog } from "./log.js";

/** システムキューの EBCDIC 変換に使う CCSID（PUB400 は 273） */
const SYSTEM_CCSID = 273;

/**
 * データ待ち行列の受信待機秒の既定上限。
 * 受信ルートは wait + 猶予(10 秒) のあいだソケットを張るので、60 秒だと最長 70 秒。
 * 無限待ち（core の wait=-1）は HTTP/MCP からは使わせず、core API だけに残す。
 */
export const DEFAULT_DTAQ_RECEIVE_MAX_WAIT_SEC = 60;

export interface HostDtaqDeps {
  resolver: ConfigResolver;
  /** 受信の待機秒の上限。無限待ち（-1）を HTTP から許さないための歯止め */
  receiveMaxWaitSec: number;
  /**
   * 接続を開く手段。**テストで偽の接続を差し込むための口**。
   * 既定は実接続（`openDtaq`）。これが無いと、encoding 変換・wait クランプ・
   * エラー写像といった本体がどれも単体テストできない（入力検証しか通らない緑になる）。
   */
  connect?: (opts: Parameters<typeof openDtaq>[0]) => Promise<DtaqConnection>;
}

const log = childLog({ component: "host-dtaq" });

/** キュー名・ライブラリは 10 文字まで（EBCDIC 10 バイト固定フィールド） */
const objectName = z.string().min(1).max(10);
const encodingSchema = z.enum(["utf8", "base64", "ebcdic"]);
const searchSchema = z.enum(["EQ", "NE", "LT", "LE", "GT", "GE"]);
const typeSchema = z.enum(["FIFO", "LIFO", "KEYED"]);

/** プロトコル上の最大エントリ長 */
const MAX_ENTRY_LENGTH = 64512;

const sendSchema = z
  .object({
    source: sourceSchema,
    library: objectName,
    name: objectName,
    data: z.string(),
    encoding: encodingSchema.default("utf8"),
    key: z.string().optional(),
    keyEncoding: encodingSchema.default("utf8")
  })
  .strict();

const receiveSchema = z
  .object({
    source: sourceSchema,
    library: objectName,
    name: objectName,
    /** 待機秒。0=待たない / 正=秒数。**負値（無限）は HTTP から許さない** */
    wait: z.number().int().min(0).default(0),
    peek: z.boolean().optional(),
    key: z.string().optional(),
    keyEncoding: encodingSchema.default("utf8"),
    search: searchSchema.optional(),
    /** entry.data をどの encoding で返すか */
    encoding: encodingSchema.default("utf8")
  })
  .strict();

const createSchema = z
  .object({
    source: sourceSchema,
    library: objectName,
    name: objectName,
    maxEntryLength: z.number().int().min(1).max(MAX_ENTRY_LENGTH),
    type: typeSchema,
    keyLength: z.number().int().min(1).max(256).optional(),
    saveSender: z.boolean().optional(),
    description: z.string().max(50).optional()
  })
  .strict();

const clearSchema = z
  .object({
    source: sourceSchema,
    library: objectName,
    name: objectName,
    key: z.string().optional(),
    keyEncoding: encodingSchema.default("utf8")
  })
  .strict();

const nameOnlySchema = z
  .object({ source: sourceSchema, library: objectName, name: objectName })
  .strict();

/** DTAQ で使う encoding。テキスト / バイナリ / システム CCSID */
export type DtaqEncoding = "utf8" | "base64" | "ebcdic";

/** base64 として妥当か（`Buffer.from` は不正文字を黙って捨てるので自前で検査する） */
function isValidBase64(text: string): boolean {
  const s = text.replace(/\s+/gu, "");
  if (s.length % 4 !== 0) return false;
  return /^[A-Za-z0-9+/]*={0,2}$/u.test(s);
}

/** テキスト（指定 encoding）をバイト列にする */
export function toBytes(text: string, encoding: DtaqEncoding): Uint8Array {
  switch (encoding) {
    case "base64":
      // **黙って切らない**——`Buffer.from(..,"base64")` は不正文字を無視して
      // 意図と違うバイト列を作る。バイナリ送信の footgun なので明示的に弾く
      if (!isValidBase64(text)) {
        throw new As400Error("CONFIG_ERROR", "data/key が正しい base64 ではありません");
      }
      return new Uint8Array(Buffer.from(text, "base64"));
    case "ebcdic":
      return codecForCcsid(SYSTEM_CCSID).encode(text).bytes;
    default:
      return new TextEncoder().encode(text);
  }
}

/** バイト列を指定 encoding の文字列にする */
export function fromBytes(bytes: Uint8Array, encoding: DtaqEncoding): string {
  switch (encoding) {
    case "base64":
      return Buffer.from(bytes).toString("base64");
    case "ebcdic":
      return codecForCcsid(SYSTEM_CCSID).decode(bytes);
    default:
      return new TextDecoder().decode(bytes);
  }
}

export function registerHostDtaqRoutes(app: Hono<{ Variables: AuthVars }>, deps: HostDtaqDeps): void {
  /** 要求ごとに接続を開いて閉じる定型。エラーの写像もここに集約する */
  const withDtaq = async (
    c: Context<{ Variables: AuthVars }>,
    source: z.infer<typeof sourceSchema>,
    run: (conn: DtaqConnection) => Promise<Response>
  ): Promise<Response> => {
    let conn: DtaqConnection | undefined;
    try {
      const connect = deps.connect ?? openDtaq;
      conn = await connect(resolveSource(deps.resolver, source, c.get("user")));
      return await run(conn);
    } catch (e) {
      const err = e as As400Error;
      return c.json({ error: err.message, code: err.code ?? "UNKNOWN" }, statusOf(err));
    } finally {
      conn?.close();
    }
  };

  const badRequest = (c: Context<{ Variables: AuthVars }>, message: string): Response =>
    c.json({ error: message }, 400);

  app.post("/api/host/dtaq/send", async (c) => {
    const parsed = sendSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return badRequest(c, parsed.error.issues[0]?.message ?? "invalid request");
    const body = parsed.data;
    return await withDtaq(c, body.source, async (conn) => {
      // 変換は withDtaq の中に置く——不正 base64 の CONFIG_ERROR を statusOf が 400 に写せる
      const entry = toBytes(body.data, body.encoding);
      const key = body.key !== undefined ? toBytes(body.key, body.keyEncoding) : undefined;
      await conn.write(body.name, body.library, entry, key);
      log.info(
        { user: c.get("user")?.username, queue: `${body.library}/${body.name}`, bytes: entry.length },
        "dtaq send"
      );
      return c.json({ ok: true });
    });
  });

  app.post("/api/host/dtaq/receive", async (c) => {
    const parsed = receiveSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return badRequest(c, parsed.error.issues[0]?.message ?? "invalid request");
    const body = parsed.data;
    // 無限待ちは弾いてあるが、上限でクランプして接続を張りっぱなしにしない
    const wait = Math.min(body.wait, deps.receiveMaxWaitSec);
    return await withDtaq(c, body.source, async (conn) => {
      const key = body.key !== undefined ? toBytes(body.key, body.keyEncoding) : undefined;
      const entry = await conn.read({
        name: body.name,
        library: body.library,
        wait,
        ...(body.peek !== undefined ? { peek: body.peek } : {}),
        ...(key !== undefined ? { key } : {}),
        ...(body.search !== undefined ? { search: body.search as DtaqSearchOrder } : {})
      });
      // 空はエラーではなく空（entry:null）
      if (entry === undefined) return c.json({ entry: null });
      return c.json({
        entry: {
          data: fromBytes(entry.data, body.encoding),
          encoding: body.encoding,
          bytes: entry.data.length,
          // 送信者情報は EBCDIC をデコードした文字列で返す（生バイトは載せない）
          ...(entry.senderInfo !== undefined
            ? { senderInfo: dtaqDecodeEbcdic(entry.senderInfo) }
            : {})
        }
      });
    });
  });

  app.post("/api/host/dtaq/create", async (c) => {
    const parsed = createSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return badRequest(c, parsed.error.issues[0]?.message ?? "invalid request");
    const body = parsed.data;
    // KEYED なら keyLength が要る／KEYED でないのに keyLength は不整合
    if (body.type === "KEYED" && body.keyLength === undefined) {
      return badRequest(c, "KEYED のキューには keyLength が必要です");
    }
    if (body.type !== "KEYED" && body.keyLength !== undefined) {
      return badRequest(c, "keyLength は KEYED のときだけ指定できます");
    }
    return await withDtaq(c, body.source, async (conn) => {
      await conn.create({
        name: body.name,
        library: body.library,
        maxEntryLength: body.maxEntryLength,
        type: body.type,
        ...(body.keyLength !== undefined ? { keyLength: body.keyLength } : {}),
        ...(body.saveSender !== undefined ? { saveSender: body.saveSender } : {}),
        ...(body.description !== undefined ? { description: body.description } : {})
      });
      log.info(
        { user: c.get("user")?.username, queue: `${body.library}/${body.name}`, type: body.type },
        "dtaq create"
      );
      return c.json({ ok: true });
    });
  });

  app.post("/api/host/dtaq/clear", async (c) => {
    const parsed = clearSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return badRequest(c, parsed.error.issues[0]?.message ?? "invalid request");
    const body = parsed.data;
    return await withDtaq(c, body.source, async (conn) => {
      const key = body.key !== undefined ? toBytes(body.key, body.keyEncoding) : undefined;
      await conn.clear(body.name, body.library, key);
      log.info({ user: c.get("user")?.username, queue: `${body.library}/${body.name}` }, "dtaq clear");
      return c.json({ ok: true });
    });
  });

  app.post("/api/host/dtaq/delete", async (c) => {
    const parsed = nameOnlySchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return badRequest(c, parsed.error.issues[0]?.message ?? "invalid request");
    const body = parsed.data;
    return await withDtaq(c, body.source, async (conn) => {
      await conn.deleteQueue(body.name, body.library);
      log.info({ user: c.get("user")?.username, queue: `${body.library}/${body.name}` }, "dtaq delete");
      return c.json({ ok: true });
    });
  });

  app.post("/api/host/dtaq/attributes", async (c) => {
    const parsed = nameOnlySchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return badRequest(c, parsed.error.issues[0]?.message ?? "invalid request");
    const body = parsed.data;
    return await withDtaq(c, body.source, async (conn) => {
      const attrs = await conn.attributes(body.name, body.library);
      return c.json(attrs);
    });
  });
}
