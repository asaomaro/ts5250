/**
 * IFS の HTTP ルート。
 *
 * 認可は他のホスト API と揃える——`c.get("user")` を `resolveSource()` に渡すだけで、
 * **実際に何を見られるかは IBM i 側の権限が決める**。ここで独自の制限を足すと、
 * 「ACS では見えるのにこの UI では見えない」という食い違いを生む。
 *
 * 接続は要求ごとに開いて閉じる（`host-connect.ts` の規約）。
 */
import type { Context, Hono } from "hono";
import { z } from "zod";
import type { As400Error, IfsConnection } from "@as400web/core";
import type { AuthVars } from "./auth.js";
import type { ConfigResolver } from "./config-resolver.js";
import { openIfs } from "./host-connect.js";
import { sourceSchema, statusOf, resolveSource } from "./host-api.js";
import { collectFiles, readCollected } from "./ifs-collect.js";
import { buildZip } from "./zip-writer.js";
import { childLog } from "./log.js";

export interface HostIfsDeps {
  resolver: ConfigResolver;
  /** zip に入れる合計バイトの上限 */
  zipMaxBytes: number;
  /** zip に入れるファイル数の上限 */
  zipMaxFiles: number;
  /** 1 ファイルの読み取り上限。超えるものはダウンロードに誘導する */
  readMaxBytes: number;
  /** 辿るディレクトリ数の上限。未指定なら ifs-collect の既定 */
  zipMaxDirectories?: number;
  /**
   * 接続を開く手段。**テストで偽の接続を差し込むための口**。
   *
   * 既定は実接続（`openIfs`）。これが無いと、ハンドラ本体
   * （413 / 409 の分岐、ヘッダの組み立て、符号化）が**どれも単体テストできない**——
   * 入力検証と純関数しか通らないテストになり、本体を壊しても緑のままになる。
   */
  connect?: (opts: Parameters<typeof openIfs>[0]) => Promise<IfsConnection>;
}

/** IFS のパス。空を弾くのは、素通しするとルート一覧になるため */
const pathSchema = z.string().min(1);
const encodingSchema = z.enum(["utf8", "base64"]);

const listSchema = z
  .object({
    source: sourceSchema,
    path: pathSchema,
    /** 1 回で取る件数。巨大ディレクトリ対策（`/QSYS.LIB` は直下 21,192 件） */
    maxCount: z.number().int().min(1).max(0xffff).optional(),
    restartId: z.number().int().min(0).max(0xffffffff).optional()
  })
  .strict();

const readSchema = z
  .object({ source: sourceSchema, path: pathSchema, encoding: encodingSchema.default("utf8") })
  .strict();

const writeSchema = z
  .object({
    source: sourceSchema,
    path: pathSchema,
    content: z.string(),
    encoding: encodingSchema.default("utf8"),
    create: z.boolean().optional()
  })
  .strict();

const pathOnlySchema = z.object({ source: sourceSchema, path: pathSchema }).strict();

/** 拡張子から Content-Type を決める。分からなければ汎用のバイナリ */
function contentTypeOf(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  switch (ext) {
    case "pdf":
      return "application/pdf";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "svg":
      return "image/svg+xml";
    case "txt":
    case "log":
      return "text/plain; charset=utf-8";
    case "json":
      return "application/json";
    default:
      return "application/octet-stream";
  }
}

/** パスの最後の要素。`Content-Disposition` のファイル名に使う */
function baseName(path: string): string {
  const trimmed = path.replace(/\/$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || "download";
}

/**
 * 添付として返すヘッダ。
 * 名前は非 ASCII を含みうるので `filename*`（RFC 5987）で渡す。
 */
function attachmentHeaders(name: string, contentType: string): Record<string, string> {
  return {
    "Content-Type": contentType,
    "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`
  };
}

/**
 * **ホスト上のファイルを変更する操作は記録を残す。**
 * 誰がどのパスを消したか分からないと、事故のとき手掛かりが無い。
 */
const log = childLog({ component: "host-ifs" });

/**
 * 親ディレクトリの一覧から、そのファイルのサイズを引く。
 * 分からなければ `undefined`（親を読めない場合など）。
 */
async function knownSize(conn: IfsConnection, path: string): Promise<number | undefined> {
  const at = path.lastIndexOf("/");
  if (at < 0) return undefined;
  const parent = at === 0 ? "/" : path.slice(0, at);
  const name = path.slice(at + 1);
  try {
    const listed = await conn.listFiles(parent);
    return listed.entries.find((e) => e.name === name && !e.isDirectory)?.size;
  } catch {
    // 親を一覧できなくても読み取り自体は通ることがある。ここでは諦める
    return undefined;
  }
}

export function registerHostIfsRoutes(app: Hono<{ Variables: AuthVars }>, deps: HostIfsDeps): void {
  /** 要求ごとに接続を開いて閉じる定型。エラーの写像もここに集約する */
  const withIfs = async (
    c: Context<{ Variables: AuthVars }>,
    source: z.infer<typeof sourceSchema>,
    run: (conn: IfsConnection) => Promise<Response>
  ): Promise<Response> => {
    let conn: IfsConnection | undefined;
    try {
      const connect = deps.connect ?? openIfs;
      conn = await connect(resolveSource(deps.resolver, source, c.get("user")));
      return await run(conn);
    } catch (e) {
      const err = e as As400Error;
      return c.json({ error: err.message, code: err.code ?? "UNKNOWN" }, statusOf(err));
    } finally {
      conn?.close();
    }
  };

  app.post("/api/host/ifs/list", async (c) => {
    const parsed = listSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message ?? "invalid request" }, 400);
    }
    const body = parsed.data;
    return await withIfs(c, body.source, async (conn) => {
      const result = await conn.listFiles(body.path, {
        ...(body.maxCount !== undefined ? { maxCount: body.maxCount } : {}),
        ...(body.restartId !== undefined ? { restartId: body.restartId } : {})
      });
      // hasMore / canContinue / nextRestartId をそのまま渡す。
      // **UI 側は hasMore だけで判断しないこと**——entries が空でも true になりうるし、
      // canContinue を見ずに続きを取ると `/QSYS.LIB` で無限ループする（core の D1・D6）
      return c.json(result);
    });
  });

  app.post("/api/host/ifs/read", async (c) => {
    const parsed = readSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message ?? "invalid request" }, 400);
    }
    const body = parsed.data;
    return await withIfs(c, body.source, async (conn) => {
      // **読む前にサイズを見る。** 読んでから判定すると、100KB/s のホストから
      // 500MB を 80 分かけて全部読み、全部メモリに載せてから断ることになる
      // （zip 側と同じ理屈。D3）。親ディレクトリの一覧 1 往復で足りる
      const known = await knownSize(conn, body.path);
      if (known !== undefined && known > deps.readMaxBytes) {
        return c.json(
          {
            error: `ファイルが大きすぎます（${known} バイト）。ダウンロードしてください`,
            code: "TOO_LARGE",
            bytes: known,
            maxBytes: deps.readMaxBytes
          },
          413
        );
      }
      const data = await conn.readFile(body.path);
      // 一覧で分からなかった場合（親を読めない等）の保険。ここは読んだ後になる
      if (data.length > deps.readMaxBytes) {
        return c.json(
          {
            error: `ファイルが大きすぎます（${data.length} バイト）。ダウンロードしてください`,
            code: "TOO_LARGE",
            bytes: data.length,
            maxBytes: deps.readMaxBytes
          },
          413
        );
      }
      if (body.encoding === "base64") {
        return c.json({
          content: Buffer.from(data).toString("base64"),
          bytes: data.length,
          encoding: "base64"
        });
      }
      // **化けさせずに失敗させる。** IFS のテキストは UTF-8 とは限らず、
      // EBCDIC（273 等）が普通にある。非 fatal な TextDecoder は U+FFFD の羅列を
      // 黙って返すので、それを編集して書き戻すと**元ファイルが壊れる**。
      // spec の決定表の最終行「復号しない。手動選択かダウンロードを促す」に倒す。
      // 中身の CCSID による復号は core が CCSID タグを出せるようになってから（decisions D7）
      try {
        const content = new TextDecoder("utf-8", { fatal: true }).decode(data);
        return c.json({ content, bytes: data.length, encoding: "utf8" });
      } catch {
        // **エラーにしない。** 読み取り自体は成功していて、足りないのは表示手段。
        // 4xx にすると UI は「失敗した」画面を出すが、実際に出したいのは
        // 「文字コードを選ぶ / ダウンロードする」という**続きの操作**
        // （spec の決定表の最終行）。415 はリクエストの形式に対する応答なので意味も合わない
        return c.json({
          content: null,
          bytes: data.length,
          encoding: null,
          code: "UNSUPPORTED_ENCODING"
        });
      }
    });
  });

  app.post("/api/host/ifs/write", async (c) => {
    const parsed = writeSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message ?? "invalid request" }, 400);
    }
    const body = parsed.data;
    return await withIfs(c, body.source, async (conn) => {
      const data =
        body.encoding === "base64"
          ? new Uint8Array(Buffer.from(body.content, "base64"))
          : new TextEncoder().encode(body.content);
      await conn.writeFile(body.path, data, { create: body.create ?? true });
      log.info({ user: c.get("user")?.username, path: body.path, bytes: data.length }, "ifs write");
      return c.json({ bytes: data.length });
    });
  });

  app.post("/api/host/ifs/mkdir", async (c) => {
    const parsed = pathOnlySchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message ?? "invalid request" }, 400);
    }
    const body = parsed.data;
    return await withIfs(c, body.source, async (conn) => {
      await conn.makeDirectory(body.path);
      log.info({ user: c.get("user")?.username, path: body.path }, "ifs mkdir");
      return c.json({ ok: true });
    });
  });

  app.post("/api/host/ifs/delete", async (c) => {
    const parsed = pathOnlySchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message ?? "invalid request" }, 400);
    }
    const body = parsed.data;
    return await withIfs(c, body.source, async (conn) => {
      await conn.deleteFile(body.path);
      log.info({ user: c.get("user")?.username, path: body.path }, "ifs delete");
      return c.json({ ok: true });
    });
  });

  app.post("/api/host/ifs/download", async (c) => {
    const parsed = pathOnlySchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message ?? "invalid request" }, 400);
    }
    const body = parsed.data;
    return await withIfs(c, body.source, async (conn) => {
      const data = await conn.readFile(body.path);
      // スプール PDF と同じく一括で返す（readFile が全バイトを返すため）
      return new Response(new Uint8Array(data), {
        headers: attachmentHeaders(baseName(body.path), contentTypeOf(body.path))
      });
    });
  });

  app.post("/api/host/ifs/zip", async (c) => {
    const parsed = pathOnlySchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message ?? "invalid request" }, 400);
    }
    const body = parsed.data;
    return await withIfs(c, body.source, async (conn) => {
      // **列挙だけで上限を判定する**。実効 100KB/s なので、読み切ってから断ると
      // 利用者を何十分も待たせたうえで失敗させることになる
      const collected = await collectFiles(conn, body.path, {
        maxBytes: deps.zipMaxBytes,
        maxFiles: deps.zipMaxFiles,
        ...(deps.zipMaxDirectories !== undefined
          ? { maxDirectories: deps.zipMaxDirectories }
          : {})
      });
      if (!collected.ok && collected.reason === "too-large") {
        return c.json(
          {
            // **「以上」と書く。** これは上限を超えた時点で打ち切った部分集計で、
            // 実際の総数ではない（21,192 件のフォルダでも「501 件」と出る）
            error: `対象が大きすぎます（${collected.files} ファイル以上 / ${collected.bytes} バイト以上）`,
            code: "TOO_LARGE",
            files: collected.files,
            bytes: collected.bytes,
            /** 打ち切った時点の集計であって総数ではない */
            partial: true,
            maxFiles: deps.zipMaxFiles,
            maxBytes: deps.zipMaxBytes
          },
          413
        );
      }
      if (!collected.ok && collected.reason === "too-many-directories") {
        return c.json(
          {
            // **「階層」ではなく「個数」。** これは辿ったディレクトリの総数であって深さではない。
            // 深さ 1 のフラットな 6,000 フォルダでもここに来る
            error: `フォルダの数が多すぎます（${collected.directories} 個以上）`,
            code: "TOO_MANY_DIRECTORIES",
            directories: collected.directories,
            partial: true
          },
          413
        );
      }
      if (!collected.ok) {
        // **部分的な zip を返さない。** 一覧を最後まで辿れない場所
        // （`/QSYS.LIB` のように Restart ID を振らないファイルシステム）では、
        // 黙って欠けたアーカイブを渡すより、辿れなかった場所を示して断る方がよい
        return c.json(
          {
            error: `${collected.path} の一覧を最後まで取得できないため、完全な zip を作れません`,
            code: "INCOMPLETE_LISTING",
            path: collected.path
          },
          409
        );
      }
      const contents = await readCollected(conn, body.path, collected.files, deps.zipMaxBytes);
      if (!contents.ok) {
        // 列挙時のサイズと実際が食い違った。列挙段で超えたときと**同じ扱い**にする
        return c.json(
          {
            error: `対象が大きすぎます（${contents.bytes} バイト以上）`,
            code: "TOO_LARGE",
            bytes: contents.bytes,
            maxBytes: deps.zipMaxBytes,
            partial: true
          },
          413
        );
      }
      const zip = buildZip(contents.files);
      return new Response(new Uint8Array(zip), {
        headers: attachmentHeaders(`${baseName(body.path)}.zip`, "application/zip")
      });
    });
  });
}
