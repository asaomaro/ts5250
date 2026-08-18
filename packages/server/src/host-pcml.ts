/**
 * **PCML から呼ぶ**（`POST /api/host/pcml/parse` / `/call`）。
 *
 * `host-program.ts` は**位置指定**——`args[0]`, `args[1]`…。構造体は base64 の手詰めになり、
 * 桁ずれが型で止まらない。ここは記述（`.pcml`）を読んで、**名前で**出し入れする道。
 *
 * ## 記述の出どころは IFS
 *
 * PCML はコンパイラが吐く（`CRTBNDRPG ... PGMINFO(*PCML) INFOSTMF('/…')`）。
 * jt400 にもホストへ問い合わせる経路は無い——原典の構築子を全て読んで確かめた。
 * だから読む先は IFS か、貼り付けた本文の 2 つだけ。
 */
import type { Hono } from "hono";
import { z } from "zod";
import { As400Error } from "@ts5250/base";
import { codecForCcsid } from "@ts5250/ebcdic";
import {
  buildPcmlCall,
  parsePcml,
  readPcmlOutputs,
  toProgramParameters,
  type CommandConnection,
  type IfsConnection,
  type PcmlDocument,
  type PcmlField
} from "@ts5250/hostserver";
import type { AuthVars } from "./auth.js";
import type { ConfigResolver } from "./config-resolver.js";
import { openCommand, openIfs } from "./host-connect.js";
import { resolveSource, sourceSchema, statusOf } from "./host-api.js";

export interface HostPcmlDeps {
  resolver: ConfigResolver;
  /** 試験で差し替えるための口（既定は実接続） */
  connect?: (opts: Parameters<typeof openCommand>[0]) => Promise<CommandConnection>;
  connectIfs?: (opts: Parameters<typeof openIfs>[0]) => Promise<IfsConnection>;
}

/** 記述の指定。**本文か IFS の道のどちらか** */
const documentSchema = z.object({
  text: z.string().min(1).max(1_000_000).optional(),
  path: z.string().min(1).max(4096).optional()
});

const parseRequestSchema = documentSchema.extend({
  source: sourceSchema.optional()
});

const callRequestSchema = documentSchema.extend({
  source: sourceSchema,
  program: z.string().min(1).max(128),
  /** 完全名 → 値。**数値も文字列**（`number` を経由すると桁が落ちる） */
  values: z.record(z.string(), z.string()).optional()
});

/**
 * `.pcml` のバイト列を文字にする。
 *
 * **実機のコンパイラは 819（ISO 8859-1）でタグを付ける**（測定済み）。
 * UTF-8 で置き直されていることもあるので、タグに従って選ぶ。
 * EBCDIC でタグ付けされていれば EBCDIC として読む——中身は ASCII 相当なので、
 * 取り違えると `<pcml` すら読めず、原因が分からない失敗になる。
 */
function decodePcmlBytes(data: Uint8Array, ccsid: number | undefined): string {
  if (ccsid === 1208) return new TextDecoder("utf-8").decode(data);
  if (ccsid === undefined || ASCII_TAGS.has(ccsid)) {
    let out = "";
    for (const b of data) out += String.fromCharCode(b);
    return out;
  }
  return codecForCcsid(ccsid).decode(data);
}

/** ASCII 系として素通しできるタグ（PCML の中身は ASCII の範囲） */
const ASCII_TAGS = new Set([367, 819, 850, 858, 923, 1252]);

/** JSON にできる形にする（`Map` はそのままでは送れない） */
function fieldToJson(f: PcmlField): Record<string, unknown> {
  const out: Record<string, unknown> = { name: f.name, path: f.path, type: f.type, usage: f.usage };
  if (f.length !== undefined) out["length"] = f.length;
  if (f.precision !== undefined) out["precision"] = f.precision;
  if (f.ccsid !== undefined) out["ccsid"] = f.ccsid;
  if (f.init !== undefined) out["init"] = f.init;
  if (f.count !== undefined) out["count"] = f.count;
  if (f.fields) out["fields"] = f.fields.map(fieldToJson);
  return out;
}

function documentToJson(doc: PcmlDocument): Record<string, unknown> {
  return {
    version: doc.version,
    programs: [...doc.programs.values()].map((p) => ({
      name: p.name,
      path: p.path,
      entrypoint: p.entrypoint,
      threadsafe: p.threadsafe,
      fields: p.fields.map(fieldToJson)
    }))
  };
}

export function registerHostPcmlRoutes(app: Hono<{ Variables: AuthVars }>, deps: HostPcmlDeps): void {
  /** 記述の本文を得る。IFS の道なら読みに行く */
  async function loadText(
    body: { text?: string | undefined; path?: string | undefined; source?: unknown },
    user: unknown
  ): Promise<string> {
    if (body.text !== undefined && body.text !== "") return body.text;
    if (body.path === undefined || body.path === "") {
      throw new As400Error("CONFIG_ERROR", "text か path のどちらかが要ります");
    }
    if (body.source === undefined) {
      throw new As400Error("CONFIG_ERROR", "path で読むには接続の指定が要ります");
    }
    const opts = resolveSource(deps.resolver, body.source as never, user as never);
    const conn = await (deps.connectIfs ?? openIfs)(opts);
    try {
      const got = await conn.readTextFile(body.path);
      return decodePcmlBytes(got.data, got.ccsid);
    } finally {
      conn.close();
    }
  }

  /** 記述を読んで**界面を返す**（画面を組むため） */
  app.post("/api/host/pcml/parse", async (c) => {
    const parsed = parseRequestSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message ?? "invalid request" }, 400);
    }
    try {
      const text = await loadText(parsed.data, c.get("user"));
      return c.json(documentToJson(parsePcml(text)));
    } catch (e) {
      const err = e as As400Error;
      return c.json({ error: err.message, code: err.code ?? "UNKNOWN" }, statusOf(err));
    }
  });

  /** 記述と名前つきの入力で**呼ぶ** */
  app.post("/api/host/pcml/call", async (c) => {
    const parsed = callRequestSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message ?? "invalid request" }, 400);
    }
    const body = parsed.data;
    const user = c.get("user");
    let conn: CommandConnection | undefined;
    try {
      const text = await loadText(body, user);
      const doc = parsePcml(text);
      const program = doc.programs.get(body.program);
      if (program?.entrypoint !== undefined) {
        // **黙って *PGM として呼ばない**——サービスプログラムは呼び方が別物で、
        // 間違った呼び方は MCH0801 などの分かりにくい失敗になる
        throw new As400Error(
          "CONFIG_ERROR",
          `${body.program} は entrypoint を持つサービスプログラムです。この経路では呼べません`
        );
      }
      const opts = resolveSource(deps.resolver, body.source, user);
      const ccsid = opts.ccsid ?? 37;
      const call = buildPcmlCall(doc, body.program, body.values ?? {}, { ccsid });

      conn = await (deps.connect ?? openCommand)(opts);
      const { result, outputs } = await conn.call(
        call.program,
        call.library,
        toProgramParameters(call.args, { ccsid })
      );
      return c.json({
        success: result.success,
        returnCode: result.returnCode,
        messages: result.messages.map((m) => ({
          id: m.id,
          text: m.text,
          severity: m.severity,
          kind: m.kind
        })),
        // **呼んだ先を返す**——記述の `path` から解いているので、目で確かめられるようにする
        called: `${call.library}/${call.program}`,
        values: result.success ? readPcmlOutputs(call, outputs) : {}
      });
    } catch (e) {
      const err = e as As400Error;
      return c.json({ error: err.message, code: err.code ?? "UNKNOWN" }, statusOf(err));
    } finally {
      conn?.close();
    }
  });
}
