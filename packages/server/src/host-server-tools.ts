/**
 * ホストサーバー経由の MCP ツール（spec「3. 公開するツール」）。
 *
 * **5250 経由のツール（`mcp-tools.ts`）とは経路が違う**ため、ファイルを分けている。
 * 5250 は画面を操作してテキストを読み取るが、こちらはホストサーバーの API を叩いて
 * 構造化された応答を得る。装置名（デバイス）も画面サイズも要らず、セッションを開かずに単発で叩ける。
 *
 * 全ツールに共通する形:
 *   1. `system` / `session` 参照を `ConfigResolver` で解決する（認可・復号はその中に閉じている）
 *   2. 接続を開き、操作し、**必ず `finally` で閉じる**（spec D2＝単発完結）
 *   3. 例外は `errorResult` に通して `isError` 応答にする
 *
 * 資格情報はツール引数に取らない（D13）。破壊的操作の専用ツールは足さない（spec D3）。
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  listJobs,
  listObjects,
  listUsers,
  query,
  As400Error,
  type ConnectOptions,
  type ProgramParameter
} from "@as400web/core";
import { childLog } from "./log.js";
import { withAudit } from "./audit.js";
import { errorResult, type ToolDeps } from "./mcp-tools.js";
import { uploadCsv, uploadRows } from "./host-upload.js";
import { listSpools, readSpoolPages, DEFAULT_SPOOLS } from "./host-spools.js";
import { openCommand, openDb, openIfs } from "./host-connect.js";

const hostLog = childLog({ component: "host-server-tools" });

/** 一覧系の取得上限。過大な応答で LLM の文脈を溢れさせないための歯止め */
const MAX_LIMIT = 1000;

// ---- 共通スキーマ ----

/**
 * 接続先の指定。**system だけで足りる**——ホストサーバーは装置名も画面サイズも使わないため。
 * セッション設定を指定してもよい（親システムに解決される）。
 */
const targetShape = {
  system: z.string().optional(),
  session: z.string().optional()
};

const messageSchema = z.object({
  id: z.string(),
  text: z.string(),
  severity: z.number(),
  kind: z.string()
});

const spoolIdSchema = z.object({
  jobName: z.string(),
  jobUser: z.string(),
  jobNumber: z.string(),
  fileName: z.string(),
  fileNumber: z.number().int()
});

/** プログラムパラメータ。MCP は JSON なのでバイト列は Base64 文字列で運ぶ */
const programParamSchema = z.union([
  z.object({ type: z.literal("in"), dataBase64: z.string() }),
  z.object({ type: z.literal("out"), length: z.number().int().positive() }),
  z.object({ type: z.literal("inout"), dataBase64: z.string(), length: z.number().int().positive() }),
  z.object({ type: z.literal("null") })
]);

type TargetInput = { system?: string | undefined; session?: string | undefined };

/**
 * 未指定（undefined）の項目を落とす。
 * `exactOptionalPropertyTypes` のため `{ user: undefined }` は
 * 「指定していない」ではなく「undefined を指定した」になってしまう。
 */
function compact<T extends object>(value: T | undefined): {
  [K in keyof T]-?: Exclude<T[K], undefined>;
} {
  if (!value) return {} as never;
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as never;
}

function toProgramParams(params: z.infer<typeof programParamSchema>[]): ProgramParameter[] {
  return params.map((p) => {
    switch (p.type) {
      case "in":
        return { type: "in", data: Uint8Array.from(Buffer.from(p.dataBase64, "base64")) };
      case "out":
        return { type: "out", length: p.length };
      case "inout":
        return {
          type: "inout",
          data: Uint8Array.from(Buffer.from(p.dataBase64, "base64")),
          length: p.length
        };
      case "null":
        return { type: "null" };
    }
  });
}

/** 応答は text（人が読む/LLM が読む）と structuredContent の両方に載せる */
function jsonResult(structured: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(structured, null, 2) }],
    structuredContent: structured
  };
}

export function registerHostServerTools(server: McpServer, deps: ToolDeps): void {
  const { resolver, user } = deps;
  const warn = (m: string): void => hostLog.warn(m);

  /** 接続先を解決する。**未指定を弾くのはここ 1 箇所**（各ツールに分岐を散らさない） */
  const target = (input: TargetInput): ConnectOptions => {
    if (!input.system && !input.session) {
      throw new As400Error("CONFIG_ERROR", "system または session を指定してください");
    }
    return resolver.resolve({ system: input.system, session: input.session }, user, warn).connect;
  };

  // ---- SQL ----

  server.registerTool(
    "host_sql",
    {
      description:
        "ホストサーバー（database）経由で SELECT を実行し、列メタデータ付きで結果を返す。" +
        "**SELECT 専用**——INSERT/UPDATE/DELETE/DDL は実行できない（更新は host_command で RUNSQL を使う）。" +
        "5250 の画面操作を介さないため、画面レイアウトに影響されない。" +
        "**maxRows は応答に載せる行数の上限であって、ホストから取得する行数の上限ではない**——" +
        "大きな表では SQL 側に FETCH FIRST n ROWS ONLY を付けること。" +
        "LOB 列は既定でロケーターのみ返す。中身が要るときは lobMaxBytes を指定する。",
      inputSchema: {
        ...targetShape,
        sql: z.string(),
        maxRows: z.number().int().positive().max(MAX_LIMIT).optional(),
        /** LOB の中身も取る場合の 1 セルあたり上限（バイト）。既定は取りに行かない */
        lobMaxBytes: z.number().int().positive().max(1024 * 1024).optional()
      },
      outputSchema: {
        columns: z.array(
          z.object({
            name: z.string(),
            typeName: z.string(),
            length: z.number(),
            scale: z.number(),
            precision: z.number(),
            ccsid: z.number(),
            nullable: z.boolean()
          })
        ),
        rows: z.array(z.record(z.string(), z.unknown())),
        rowCount: z.number(),
        /** maxRows で切り詰めたか。**切ったことを黙らない** */
        truncated: z.boolean()
      }
    },
    async (input) =>
      withAudit({ op: "host_sql" }, async () => {
        const conn = await openDb(target(input));
        try {
          const max = input.maxRows ?? 200;
          // **切り詰めは応答側だけ**。`query` は結果セットを全件取得してから返すため、
          // ここでの slice はホストからの取得量を減らさない。取得量を抑えるのは呼び出し側の
          // SQL（FETCH FIRST）の責任——`stream` で早期打ち切りする案は、カーソルを
          // 途中で閉じる経路が未検証（backlog 記載）のため採らない。
          const result = await query(
            conn,
            input.sql,
            input.lobMaxBytes ? { lob: { maxBytes: input.lobMaxBytes } } : {}
          );
          const rows = result.rows.slice(0, max);
          return jsonResult({
            columns: result.columns.map((c) => ({
              name: c.name,
              typeName: c.typeName,
              length: c.length,
              scale: c.scale,
              precision: c.precision,
              ccsid: c.ccsid,
              nullable: c.nullable
            })),
            // bigint は JSON にできないため文字列にする（精度を落とさない）
            rows: rows.map((r) =>
              Object.fromEntries(
                Object.entries(r).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v])
              )
            ),
            rowCount: rows.length,
            truncated: result.rows.length > rows.length
          });
        } finally {
          conn.close();
        }
      }).catch(errorResult)
  );

  // ---- CSV の取り込み（DDM。**書き込み系**）----

  server.registerTool(
    "host_upload_table",
    {
      description:
        "CSV を IBM i の表へ**追加**する（database サーバー経由の INSERT）。" +
        "**追加のみ**——更新・削除・表の作成はできない。" +
        "csv（文字列）か columns+rows のどちらかで渡す。" +
        "型はホストが解釈するので CHAR / VARCHAR / 数値 / 日付時刻 / GRAPHIC を扱える。" +
        "値はパラメータとして渡すため、引用符を含む文字列もそのまま入る。" +
        "表せない文字（列の CCSID で書けない文字）は置換せず拒否する。" +
        "⚠ **コミットメント制御が無いため巻き戻せない**——途中で失敗しても書けた分は残る。" +
        "その場合 committedRows（確定した行数）と uncertainRange（確定不明な行範囲）を返す。",
      inputSchema: {
        ...targetShape,
        library: z.string(),
        file: z.string(),
        /** CSV 文字列（ヘッダー行を含む）。columns+rows と排他 */
        csv: z.string().optional(),
        columns: z.array(z.string()).optional(),
        rows: z.array(z.array(z.string().nullable())).optional(),
        emptyAsNull: z.boolean().optional()
      },
      outputSchema: {
        ok: z.boolean(),
        /** 書き込みが確定した行数 */
        committedRows: z.number().optional(),
        /** 確定したか**不明**な行範囲（1 始まり）。ここは重複投入の危険がある */
        uncertainRange: z.object({ from: z.number(), to: z.number() }).optional(),
        batchSize: z.number().optional(),
        ms: z.number().optional(),
        /** 拒否理由（1 行も書いていない） */
        rejections: z.array(z.record(z.string(), z.unknown())).optional(),
        truncated: z.boolean().optional()
      }
    },
    async (input) =>
      withAudit({ op: "host_upload_table" }, async () => {
        const hasRows = input.columns !== undefined && input.rows !== undefined;
        if (!input.csv && !hasRows) {
          throw new As400Error("CONFIG_ERROR", "csv か columns+rows のどちらかを指定してください");
        }
        if (input.csv && hasRows) {
          throw new As400Error("CONFIG_ERROR", "csv と columns+rows は同時に指定できません");
        }
        const common = {
          opts: target(input),
          library: input.library,
          file: input.file,
          ...(input.emptyAsNull !== undefined ? { emptyAsNull: input.emptyAsNull } : {})
        };
        // **HTTP と同じ実行経路を通す**（入口が違うだけ。検査を二重に持たない）
        const outcome = input.csv
          ? await uploadCsv({ ...common, csv: input.csv })
          : await uploadRows({ ...common, header: input.columns!, rows: input.rows! });
        return jsonResult(outcome);
      }).catch(errorResult)
  );

  // ---- コマンド / プログラム呼び出し ----

  server.registerTool(
    "host_command",
    {
      description:
        "ホストサーバー（コマンドサーバー）経由で CL コマンドを実行し、成否とメッセージを構造化して返す。" +
        "**非対話のコマンドのみ**——画面を出す対話型コマンドは扱えない（5250 の run_steps を使う）。" +
        "実行できる範囲は接続設定の資格情報が IBM i 上で持つ権限が決める。",
      inputSchema: { ...targetShape, command: z.string() },
      outputSchema: {
        success: z.boolean(),
        returnCode: z.number(),
        messages: z.array(messageSchema)
      }
    },
    async (input) =>
      withAudit({ op: "host_command" }, async () => {
        const conn = await openCommand(target(input));
        try {
          // run は失敗しても throw しない。メッセージを返すほうが呼び出し側に有用
          const r = await conn.run(input.command);
          return jsonResult({
            success: r.success,
            returnCode: r.returnCode,
            messages: r.messages.map((m) => ({
              id: m.id,
              text: m.text,
              severity: m.severity,
              kind: m.kind
            }))
          });
        } finally {
          conn.close();
        }
      }).catch(errorResult)
  );

  server.registerTool(
    "host_call_program",
    {
      description:
        "ホストサーバー経由で IBM i のプログラム（QSYS の API 等）を呼ぶ。" +
        "バイト列は Base64 で受け渡す。**出力パラメータは要求した順で返る前提**で位置合わせしている。",
      inputSchema: {
        ...targetShape,
        program: z.string(),
        library: z.string(),
        params: z.array(programParamSchema)
      },
      outputSchema: {
        success: z.boolean(),
        returnCode: z.number(),
        messages: z.array(messageSchema),
        /** 要求順。出力でないパラメータの位置は null */
        outputs: z.array(z.string().nullable())
      }
    },
    async (input) =>
      withAudit({ op: "host_call_program" }, async () => {
        const conn = await openCommand(target(input));
        try {
          const { result, outputs } = await conn.call(
            input.program,
            input.library,
            toProgramParams(input.params)
          );
          return jsonResult({
            success: result.success,
            returnCode: result.returnCode,
            messages: result.messages.map((m) => ({
              id: m.id,
              text: m.text,
              severity: m.severity,
              kind: m.kind
            })),
            outputs: outputs.map((o) => (o ? Buffer.from(o).toString("base64") : null))
          });
        } finally {
          conn.close();
        }
      }).catch(errorResult)
  );

  // ---- スプール（pull 型） ----

  server.registerTool(
    "host_list_spools",
    {
      description:
        "ホストサーバー経由で**既存の**スプールファイルを任意の出力待ち行列から検索する（pull 型）。" +
        "5250 の list_spools とは別物——あちらはプリンターセッションで受信済みの帳票（push 型）で、" +
        "セッションを開いておく必要があり過去のスプールは取れない。" +
        "見える範囲は資格情報の権限が決める（一般ユーザーは自分のスプールのみ）。",
      inputSchema: {
        ...targetShape,
        filter: z
          .object({
            user: z.string().optional(),
            outputQueue: z.string().optional(),
            outputQueueLibrary: z.string().optional(),
            status: z.string().optional(),
            formType: z.string().optional(),
            userData: z.string().optional()
          })
          .optional(),
        max: z.number().int().positive().max(MAX_LIMIT).optional()
      },
      outputSchema: { items: z.array(z.record(z.string(), z.unknown())), count: z.number() }
    },
    async (input) =>
      withAudit({ op: "host_list_spools" }, async () => {
        // HTTP ルートと**同じ共有関数**を通す（spec 方針1）。
        // 出力は従来どおり { items, count }——total の公開は別課題（外部仕様を変えない）
        const page = await listSpools(
          target(input),
          compact(input.filter),
          input.max ?? DEFAULT_SPOOLS
        );
        return jsonResult({ items: page.items, count: page.items.length });
      }).catch(errorResult)
  );

  server.registerTool(
    "host_get_spool",
    {
      description:
        "ホストサーバー経由でスプールファイルの中身を取得する（host_list_spools で得た id を渡す）。" +
        "ccsid は SCS のデコードに使う（既定 273。日本語環境では 930 / 939 / 5035）。" +
        "format=pages で論理ページごとに、text で全行をまとめて返す。",
      inputSchema: {
        ...targetShape,
        id: spoolIdSchema,
        format: z.enum(["text", "pages"]).optional(),
        ccsid: z.number().int().optional()
      },
      outputSchema: {
        lines: z.array(z.string()).optional(),
        pages: z
          .array(z.object({ rows: z.number(), cols: z.number(), lines: z.array(z.string()) }))
          .optional()
      }
    },
    async (input) =>
      withAudit({ op: "host_get_spool" }, async () => {
        // HTTP ルートと同じ共有関数を通す（spec 方針1）。
        // text 形式は論理ページを平坦化するだけ——core の readSpooledText と同じ扱い
        const pages = await readSpoolPages(target(input), input.id, input.ccsid);
        if (input.format === "pages") return jsonResult({ pages });
        return jsonResult({ lines: pages.flatMap((p) => p.lines) });
      }).catch(errorResult)
  );

  // ---- IFS ----

  server.registerTool(
    "host_read_file",
    {
      description:
        "IFS のファイルを読む。encoding=utf8 でテキスト、base64 でバイナリとして返す。" +
        "ディレクトリ操作は未対応。",
      inputSchema: {
        ...targetShape,
        path: z.string(),
        encoding: z.enum(["utf8", "base64"]).optional()
      },
      outputSchema: { content: z.string(), bytes: z.number() }
    },
    async (input) =>
      withAudit({ op: "host_read_file" }, async () => {
        const conn = await openIfs(target(input));
        try {
          const data = await conn.readFile(input.path);
          const buf = Buffer.from(data);
          return jsonResult({
            content: buf.toString(input.encoding === "base64" ? "base64" : "utf8"),
            bytes: data.length
          });
        } finally {
          conn.close();
        }
      }).catch(errorResult)
  );

  server.registerTool(
    "host_write_file",
    {
      description:
        "IFS へファイルを書く。encoding は content の解釈（既定 utf8）。" +
        "**親ディレクトリが無い場合は失敗する**（ディレクトリ作成は未対応）。" +
        "削除は専用ツールを設けていない——host_command の RMVLNK を使う。",
      inputSchema: {
        ...targetShape,
        path: z.string(),
        content: z.string(),
        encoding: z.enum(["utf8", "base64"]).optional(),
        create: z.boolean().optional()
      },
      outputSchema: { bytes: z.number() }
    },
    async (input) =>
      withAudit({ op: "host_write_file" }, async () => {
        const conn = await openIfs(target(input));
        try {
          const data = Uint8Array.from(
            Buffer.from(input.content, input.encoding === "base64" ? "base64" : "utf8")
          );
          await conn.writeFile(
            input.path,
            data,
            input.create !== undefined ? { create: input.create } : {}
          );
          return jsonResult({ bytes: data.length });
        } finally {
          conn.close();
        }
      }).catch(errorResult)
  );

  // ---- 一覧（HTTP の /api/host/list/:kind と同じ core 関数を叩く） ----

  server.registerTool(
    "host_list_jobs",
    {
      description:
        "ホストサーバー経由でジョブを一覧する。5250 の get_job_info（DSPJOB の画面操作）と違い" +
        "構造化された応答が返る。見える範囲は資格情報の権限が決める。",
      inputSchema: {
        ...targetShape,
        filter: z
          .object({
            name: z.string().optional(),
            user: z.string().optional(),
            number: z.string().optional(),
            type: z.string().optional()
          })
          .optional(),
        max: z.number().int().positive().max(MAX_LIMIT).optional()
      },
      outputSchema: { items: z.array(z.record(z.string(), z.unknown())), count: z.number() }
    },
    async (input) =>
      withAudit({ op: "host_list_jobs" }, async () => {
        const conn = await openCommand(target(input));
        try {
          const items = await listJobs(conn, compact(input.filter), { max: input.max ?? 100 });
          return jsonResult({ items, count: items.length });
        } finally {
          conn.close();
        }
      }).catch(errorResult)
  );

  server.registerTool(
    "host_list_objects",
    {
      description: "ホストサーバー経由でオブジェクトを一覧する（ライブラリ・名前・型で絞り込み）。",
      inputSchema: {
        ...targetShape,
        filter: z
          .object({
            name: z.string().optional(),
            library: z.string().optional(),
            type: z.string().optional()
          })
          .optional(),
        max: z.number().int().positive().max(MAX_LIMIT).optional()
      },
      outputSchema: { items: z.array(z.record(z.string(), z.unknown())), count: z.number() }
    },
    async (input) =>
      withAudit({ op: "host_list_objects" }, async () => {
        const conn = await openCommand(target(input));
        try {
          const items = await listObjects(conn, compact(input.filter), { max: input.max ?? 200 });
          return jsonResult({ items, count: items.length });
        } finally {
          conn.close();
        }
      }).catch(errorResult)
  );

  server.registerTool(
    "host_list_users",
    {
      description: "ホストサーバー経由でユーザープロファイルを一覧する。",
      inputSchema: {
        ...targetShape,
        filter: z
          .object({
            selection: z.enum(["*USER", "*GROUP", "*MEMBER"]).optional(),
            startingUser: z.string().optional()
          })
          .optional(),
        max: z.number().int().positive().max(MAX_LIMIT).optional()
      },
      outputSchema: { items: z.array(z.record(z.string(), z.unknown())), count: z.number() }
    },
    async (input) =>
      withAudit({ op: "host_list_users" }, async () => {
        const conn = await openCommand(target(input));
        try {
          const items = await listUsers(conn, compact(input.filter), { max: input.max ?? 200 });
          return jsonResult({ items, count: items.length });
        } finally {
          conn.close();
        }
      }).catch(errorResult)
  );
}
