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
import { As400Error } from "@as400web/core";
import type { IfsConnection } from "@as400web/core";
import type { AuthVars } from "./auth.js";
import type { ConfigResolver } from "./config-resolver.js";
import { openIfs } from "./host-connect.js";
import { sourceSchema, statusOf, resolveSource } from "./host-api.js";
import { collectFiles, readCollected } from "./ifs-collect.js";
import { decodeIfsText, encodeIfsText } from "./ifs-text.js";
import { planDelete, type DeleteTarget } from "./ifs-delete.js";
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
  /**
   * 再帰削除で消せる対象の総数の上限。既定 1,000。
   * zip（ファイル 500）より広いが、**事故の規模を抑える**ための歯止めであることは同じ。
   */
  deleteMaxEntries?: number;
  /** 再帰削除で辿るディレクトリ数の上限。既定 500（zip の 5,000 より絞る） */
  deleteMaxDirectories?: number;
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

/** 文字コードの手動指定。0 と 65535 は「未タグ」「バイナリ」の意味なので受けない */
const ccsidSchema = z.number().int().min(1).max(0xfffe);
const newlineSchema = z.enum(["lf", "nel"]);

const readSchema = z
  .object({
    source: sourceSchema,
    path: pathSchema,
    encoding: encodingSchema.default("utf8"),
    /** 利用者が選んだ文字コード。自動判定（中身 → タグ）より優先する */
    ccsid: ccsidSchema.optional()
  })
  .strict();

const writeSchema = z
  .object({
    source: sourceSchema,
    path: pathSchema,
    content: z.string(),
    encoding: encodingSchema.default("utf8"),
    /** 読んだときの文字コード。指定が無ければ UTF-8（従来どおり） */
    ccsid: ccsidSchema.optional(),
    /** 読んだときの行末と BOM。渡すと元のファイルの流儀のまま書き戻せる */
    newline: newlineSchema.optional(),
    bom: z.boolean().optional(),
    create: z.boolean().optional()
  })
  .strict();

const pathOnlySchema = z.object({ source: sourceSchema, path: pathSchema }).strict();

const deleteSchema = z
  .object({
    source: sourceSchema,
    path: pathSchema,
    /** フォルダの中身ごと消す。**既定は false**（空でなければ NOT_EMPTY で断る） */
    recursive: z.boolean().optional()
  })
  .strict();

/**
 * 改名。`newName` は**名前だけ**——`/` を含めない。
 *
 * プロトコル（0x000F）は元も先もフルパスなので移動もできるが、
 * **UI の要件は同一フォルダ内の改名まで**。移動を許すかはここで決まる（research F1）。
 */
const renameSchema = z
  .object({
    source: sourceSchema,
    path: pathSchema,
    newName: z.string().min(1).max(255)
  })
  .strict();

/** 再帰削除の既定の上限 */
const DEFAULT_DELETE_MAX_ENTRIES = 1000;
const DEFAULT_DELETE_MAX_DIRECTORIES = 500;

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

/**
 * 対象の種別を親ディレクトリの一覧から引く（`knownSize` と同じ手口）。分からなければ `undefined`。
 *
 * **種別を UI に判断させない**——ディレクトリに `deleteFile`（0x000C）を投げると rc=13 になり、
 * 「権限がありません」という原因を説明しないメッセージが出る（research F4）。
 */
async function entryKind(
  conn: IfsConnection,
  path: string
): Promise<"file" | "directory" | undefined> {
  const at = path.lastIndexOf("/");
  if (at < 0) return undefined;
  const parent = at === 0 ? "/" : path.slice(0, at);
  const name = path.slice(at + 1);
  try {
    const listed = await conn.listFiles(parent);
    const found = listed.entries.find((e) => e.name === name);
    if (!found) return undefined;
    // シンボリックリンクは**リンク自体を消す**ので file 扱い（リンク先は消さない）
    return found.isDirectory && !found.isSymlink ? "directory" : "file";
  } catch {
    // 親を一覧できなくても対象の操作自体は通ることがある
    return undefined;
  }
}

/** 削除の上限（未指定なら既定） */
function deleteLimits(deps: HostIfsDeps): { maxEntries: number; maxDirectories: number } {
  return {
    maxEntries: deps.deleteMaxEntries ?? DEFAULT_DELETE_MAX_ENTRIES,
    maxDirectories: deps.deleteMaxDirectories ?? DEFAULT_DELETE_MAX_DIRECTORIES
  };
}

/** 「消せない」を利用者向けの形にする。**理由ごとに次の一手が違う**ので、まとめて 1 文にしない */
function deleteBlocked(
  plan: { reason: "too-many"; entries: number } | { reason: "too-many-directories"; directories: number } | { reason: "incomplete"; path: string },
  limits: { maxEntries: number; maxDirectories: number }
): Record<string, unknown> {
  switch (plan.reason) {
    case "too-many":
      return { blocked: "too-many", code: "TOO_MANY", entries: plan.entries, max: limits.maxEntries };
    case "too-many-directories":
      return {
        blocked: "too-many-directories",
        code: "TOO_MANY_DIRECTORIES",
        directories: plan.directories,
        max: limits.maxDirectories
      };
    default:
      return {
        error: `${plan.path} の一覧を最後まで取得できないため、まとめて削除できません`,
        code: "INCOMPLETE_LISTING",
        path: plan.path
      };
  }
}

/** 1 件ずつ消す。**深い順に並んだ計画をそのまま実行する**（順序を守らないと rmdir が rc=9 で止まる） */
async function runDelete(
  conn: IfsConnection,
  targets: readonly DeleteTarget[]
): Promise<{ files: number; directories: number }> {
  let files = 0;
  let directories = 0;
  for (const t of targets) {
    if (t.kind === "directory") {
      await conn.removeDirectory(t.path);
      directories++;
    } else {
      await conn.deleteFile(t.path);
      files++;
    }
  }
  return { files, directories };
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
      // **base64（ダウンロード・プレビュー）では CCSID タグを引かない**——復号しないので
      // 要らないし、1 往復増やす理由が無い
      const file =
        body.encoding === "base64"
          ? { data: await conn.readFile(body.path), ccsid: undefined }
          : await conn.readTextFile(body.path);
      const data = file.data;
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
      // **化けさせずに失敗させる。** IFS のテキストは UTF-8 とは限らず、EBCDIC（273 等）が普通にある。
      // 決定表（手動 → BOM → UTF-8 → タグ）は `ifs-text.ts` に閉じてある
      const tag = file.ccsid;
      const decoded = decodeIfsText(data, tag, body.ccsid);
      if (!decoded.ok) {
        if (decoded.failure === "manual-unsupported") {
          return c.json(
            { error: `対応していない文字コードです（CCSID ${body.ccsid}）`, code: "UNSUPPORTED_CCSID" },
            400
          );
        }
        if (decoded.failure === "manual-failed") {
          return c.json(
            {
              error: `CCSID ${body.ccsid} として読めませんでした。別の文字コードを選んでください`,
              code: "DECODE_FAILED"
            },
            400
          );
        }
        // **エラーにしない。** 読み取り自体は成功していて、足りないのは表示手段。
        // 4xx にすると UI は「失敗した」画面を出すが、実際に出したいのは
        // 「文字コードを選ぶ / ダウンロードする」という**続きの操作**。
        // タグを添えて返すと、UI が「タグは CCSID 850 です」と手掛かりを出せる
        return c.json({
          content: null,
          bytes: data.length,
          encoding: null,
          code: "UNSUPPORTED_ENCODING",
          ...(tag !== undefined ? { tagCcsid: tag } : {})
        });
      }
      return c.json({
        content: decoded.value.content,
        bytes: data.length,
        encoding: "utf8",
        ccsid: decoded.value.ccsid,
        detectedBy: decoded.value.detectedBy,
        newline: decoded.value.newline,
        bom: decoded.value.bom,
        ...(tag !== undefined ? { tagCcsid: tag } : {})
      });
    });
  });

  app.post("/api/host/ifs/write", async (c) => {
    const parsed = writeSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message ?? "invalid request" }, 400);
    }
    const body = parsed.data;
    return await withIfs(c, body.source, async (conn) => {
      let data: Uint8Array;
      let substituted = 0;
      if (body.encoding === "base64") {
        // base64 は**バイト列をそのまま置く**経路（アップロード・バイナリ）。
        // 文字コードの変換をしないので ccsid / newline / bom は使わない
        data = new Uint8Array(Buffer.from(body.content, "base64"));
      } else {
        // **読んだときの文字コードで書き戻す**。無指定は従来どおり UTF-8。
        // 行末（EBCDIC の 0x15）と BOM も、読んだときの流儀に戻す
        const encoded = encodeIfsText(body.ccsid ?? 1208, body.content, {
          ...(body.newline !== undefined ? { newline: body.newline } : {}),
          ...(body.bom !== undefined ? { bom: body.bom } : {})
        });
        if (!encoded.ok) {
          return c.json(
            {
              error: `この文字コードでは保存できません（CCSID ${body.ccsid}）`,
              code: "UNSUPPORTED_CCSID"
            },
            400
          );
        }
        data = encoded.bytes;
        substituted = encoded.substituted;
      }
      await conn.writeFile(body.path, data, { create: body.create ?? true });
      log.info(
        {
          user: c.get("user")?.username,
          path: body.path,
          bytes: data.length,
          ...(body.ccsid !== undefined ? { ccsid: body.ccsid } : {}),
          ...(substituted > 0 ? { substituted } : {})
        },
        "ifs write"
      );
      // **置換が起きたことは黙って捨てない**——利用者が選んだ文字コードで表せない文字が
      // SUB に落ちている。書き込み自体は要求どおり行い、件数を返して UI に警告させる
      return c.json({ bytes: data.length, ...(substituted > 0 ? { substituted } : {}) });
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

  /**
   * 削除。**種別の判定と再帰の要否はここで決める**（UI に持たせない。research F4）。
   *
   * 従来の要求形（`{ source, path }`）はそのまま通る——`recursive` を指定しなければ
   * ファイルは消え、フォルダは空のときだけ消える。
   */
  app.post("/api/host/ifs/delete", async (c) => {
    const parsed = deleteSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message ?? "invalid request" }, 400);
    }
    const body = parsed.data;
    const limits = deleteLimits(deps);
    return await withIfs(c, body.source, async (conn) => {
      const kind = await entryKind(conn, body.path);
      const user = c.get("user")?.username;

      // ファイル・リンク、または種別が分からないもの。**分からないときはファイルとして試す**
      /**
       * ファイルとして消そうとして rc=13 だったときの元エラー。
       *
       * 実はディレクトリだと、ファイル削除（0x000C）は rc=13（権限がありません）で返る（research F4）。
       * 種別を引けなかった場合だけディレクトリとして解釈し直すが、**それも失敗したら元のエラーを返す**——
       * 本当に権限が無いファイルに対して、rmdir の rc=3 由来の「見つかりません」を返すと余計に分からない
       */
      let fileError: As400Error | undefined;
      if (kind !== "directory") {
        try {
          await conn.deleteFile(body.path);
          log.info({ user, path: body.path, files: 1 }, "ifs delete");
          return c.json({ files: 1, directories: 0 });
        } catch (e) {
          const err = e as As400Error;
          if (kind !== undefined || err.code !== "ACCESS_DENIED") throw err;
          fileError = err;
        }
      }
      /** ディレクトリとしての解釈も失敗したら、ファイルとしての元エラーに戻す */
      const asDirectory = async <T>(run: () => Promise<T>): Promise<T> => {
        try {
          return await run();
        } catch (e) {
          throw fileError ?? e;
        }
      };

      if (!body.recursive) {
        // 空でなければ rc=9 → NOT_EMPTY（409）。UI が「中身ごと消しますか？」へ誘導する
        await asDirectory(() => conn.removeDirectory(body.path));
        log.info({ user, path: body.path, directories: 1 }, "ifs delete");
        return c.json({ files: 0, directories: 1 });
      }

      // **数えてから消す。** 上限を超えていれば 1 件も消さない（部分削除を作らない）
      const plan = await asDirectory(() => planDelete(conn, body.path, limits));
      if (!plan.ok) return c.json(deleteBlocked(plan, limits), 409);
      try {
        const done = await runDelete(conn, plan.targets);
        log.info({ user, path: body.path, ...done, recursive: true }, "ifs delete");
        return c.json(done);
      } catch (e) {
        // **途中で止まった。** 消せたところまでは実際に消えている。黙って続行も、
        // 「全部失敗した」ように見せるのも誤り
        const err = e as As400Error;
        log.warn({ user, path: body.path, error: err.message }, "ifs delete stopped");
        return c.json({ error: err.message, code: err.code ?? "UNKNOWN", partial: true }, statusOf(err));
      }
    });
  });

  /** 削除の規模を先に数える（確認ダイアログ用。**ここでは何も消さない**） */
  app.post("/api/host/ifs/delete-plan", async (c) => {
    const parsed = pathOnlySchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message ?? "invalid request" }, 400);
    }
    const body = parsed.data;
    const limits = deleteLimits(deps);
    return await withIfs(c, body.source, async (conn) => {
      const kind = await entryKind(conn, body.path);
      if (kind !== "directory") return c.json({ files: 1, directories: 0, entries: 1 });
      const plan = await planDelete(conn, body.path, limits);
      if (!plan.ok) {
        if (plan.reason === "incomplete") {
          return c.json(deleteBlocked(plan, limits), 409);
        }
        // 上限超過は**エラーではなく「消せない」という事実**。確認ダイアログがそのまま案内に使う
        return c.json(deleteBlocked(plan, limits));
      }
      return c.json({
        files: plan.files,
        directories: plan.directories,
        entries: plan.targets.length
      });
    });
  });

  /**
   * 改名。`newName` は名前だけを受け取り、**親ディレクトリはサーバーが付ける**。
   * これで「移動」を許さない（プロトコル上は移動もできる。research F1）。
   */
  app.post("/api/host/ifs/rename", async (c) => {
    const parsed = renameSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message ?? "invalid request" }, 400);
    }
    const body = parsed.data;
    if (body.newName.includes("/") || body.newName === "." || body.newName === "..") {
      return c.json({ error: "名前にパス区切りは使えません", code: "INVALID_NAME" }, 400);
    }
    const at = body.path.lastIndexOf("/");
    if (at < 0) return c.json({ error: "パスが不正です", code: "INVALID_NAME" }, 400);
    const parent = at === 0 ? "" : body.path.slice(0, at);
    const target = `${parent}/${body.newName}`;
    return await withIfs(c, body.source, async (conn) => {
      try {
        // 置換しない（既存名なら rc=4 → ALREADY_EXISTS）。上書きは要件に無い
        await conn.rename(body.path, target);
      } catch (e) {
        const err = e as As400Error;
        // **フォルダを「既存のファイル名」へ改名すると rc=3（Path not found）が返る**（実機で確認）。
        // そのままだと「対象が見つかりません」になるが、実際は**その名前が既に使われている**。
        // 失敗したときだけ確かめる（成功する経路に往復を足さない）
        if (err.code === "NOT_FOUND" && (await entryKind(conn, target)) !== undefined) {
          throw new As400Error("ALREADY_EXISTS", `${body.newName} は既に使われています`);
        }
        throw err;
      }
      log.info({ user: c.get("user")?.username, path: body.path, to: target }, "ifs rename");
      return c.json({ path: target });
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
