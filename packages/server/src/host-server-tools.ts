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
import { As400Error } from "@ts5250/base";
import {
  listJobs,
  listObjects,
  listUsers,
  queryLimited,
  executeStatement,
  isNonQueryStatement,
  dtaqDecodeEbcdic,
  capturePlan,
  listPlansFromCache,
  type ProgramParameter,
  type QueryPlan,
  type PlanTreeNode,
  toProgramParameters,
  fromProgramOutputs,
  type ProgramArg,
  buildServiceProgramParams,
  splitServiceProgramOutputs,
  openQuery
} from "@ts5250/hostserver";
import { renderSpoolHtml } from "@ts5250/scs";
import { isKatakanaCcsid } from "@ts5250/ebcdic/katakana";
import { type ConnectOptions } from "@ts5250/tn5250";
import { childLog } from "./log.js";
import { withAudit } from "./audit.js";
import { errorResult, type ToolDeps } from "./mcp-tools.js";
import { uploadCsv, uploadRows } from "./host-upload.js";
import { listSpools, readSpoolPages, DEFAULT_SPOOLS } from "./host-spools.js";
import { openCommand, openDb, openIfs, openDtaq } from "./host-connect.js";
import { buildListSql, buildSendCommand, buildReplyCommand, removeByKey } from "./host-message.js";
import { toBytes, fromBytes, DEFAULT_DTAQ_RECEIVE_MAX_WAIT_SEC } from "./host-dtaq.js";

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
        "ホストサーバー（database）経由で SQL を実行する。SELECT は列メタデータ付きで結果を返す。" +
        "5250 の画面操作を介さないため、画面レイアウトに影響されない。" +
        "**INSERT/UPDATE/DELETE/DDL は allowWrite: true を明示したときだけ実行する**" +
        "——取り消せないので、書くつもりであることを毎回述べさせる。" +
        "**maxRows はホストから取得する行数の上限**（既定 200）——上限に達したら結果セットを" +
        "打ち切るので、大きな表でも全行を読み込まない。続きがある場合は truncated: true を返す。" +
        "LOB 列は既定でロケーターのみ返す。中身が要るときは lobMaxBytes を指定する。",
      inputSchema: {
        ...targetShape,
        sql: z.string(),
        maxRows: z.number().int().positive().max(MAX_LIMIT).optional(),
        /** LOB の中身も取る場合の 1 セルあたり上限（バイト）。既定は取りに行かない */
        lobMaxBytes: z.number().int().positive().max(1024 * 1024).optional(),
        /**
         * **これ以下の LOB を行データに載せて返させる**（バイト。既定 0＝載せない）。
         *
         * ロケーターを 1 つずつ引き直す往復が消えるので、**往復が高い相手ほど効く**。
         * 実測（LOB セル 6 個・pub400・インターネット越し）:
         * 既定 0 ＋ `lobMaxBytes` は 12 往復 / 5,014ms、しきい値 65536 なら 4 往復 / 1,306ms。
         *
         * ⚠ **行そのものが膨らむ**（中身を取らない既定の 982B → 5,078B）ので大きくしすぎない。
         */
        lobThreshold: z.number().int().min(0).max(15 * 1024 * 1024).optional(),
        /**
         * **結果を返さない文（INSERT/UPDATE/DELETE/DDL）を実行してよいか。** 既定 false。
         *
         * ⚠ **これは安全の境界ではない。** `host_command` から `RUNSQL` を撃てば同じことが
         * できるので、SELECT 専用に縛っても書き込みは止まらない。**意図を毎回述べさせる**
         * ためのもので、「SELECT のつもりで打った文が更新だった」を防ぐ。
         */
        allowWrite: z.boolean().optional()
      },
      outputSchema: {
        /** `"query"`＝行が返った / `"execute"`＝結果を返さない文を実行した */
        kind: z.enum(["query", "execute"]),
        /** 以下はクエリのとき */
        columns: z
          .array(
            z.object({
              name: z.string(),
              typeName: z.string(),
              length: z.number(),
              scale: z.number(),
              precision: z.number(),
              ccsid: z.number(),
              nullable: z.boolean()
            })
          )
          .optional(),
        rows: z.array(z.record(z.string(), z.unknown())).optional(),
        rowCount: z.number().optional(),
        /** 上限で**取得を打ち切ったか**（続きがある）。切ったことを黙らない */
        truncated: z.boolean().optional(),
        /** 以下は結果を返さない文のとき */
        updateCount: z.number().optional(),
        /** 影響行数に意味があるか。**DDL の 0 と DML の 0 行を混ぜない** */
        hasRowCount: z.boolean().optional(),
        /** 正の SQLCODE（成功だが伝えるべきこと。実ライブラリーへの CREATE は 7905） */
        warning: z.object({ sqlCode: z.number(), sqlState: z.string() }).optional()
      }
    },
    async (input) =>
      withAudit({ op: "host_sql" }, async () => {
        // **結果を返さない文は明示のときだけ。** 接続する前に断る——
        // 断るつもりの呼び出しでホストへ出て行かない
        const write = isNonQueryStatement(input.sql);
        if (write && input.allowWrite !== true) {
          throw new As400Error(
            "CONFIG_ERROR",
            "結果を返さない文（INSERT/UPDATE/DELETE/DDL）は allowWrite: true を指定したときだけ実行します" +
              "（取り消せないため）"
          );
        }
        const conn = await openDb(target(input), input.lobThreshold);
        try {
          if (write) {
            const r = await executeStatement(conn, input.sql);
            return jsonResult({
              kind: "execute" as const,
              updateCount: r.updateCount,
              hasRowCount: r.hasRowCount,
              ...(r.warning ? { warning: r.warning } : {})
            });
          }
          const max = input.maxRows ?? 200;
          // **上限はホストからの取得量の上限**。`queryLimited` が上限＋1 行で結果セットを
          // 打ち切る（20,000 行の表で 1.2MB / 2.1 秒 → 約 12KB / 45ms。
          // `20260730-sql-fetch-limit` research F2）。
          // 以前は `query`（全件取得）＋応答側の slice で、**取得量は減っていなかった**
          const result = await queryLimited(conn, input.sql, {
            limit: max,
            ...(input.lobMaxBytes ? { lob: { maxBytes: input.lobMaxBytes } } : {})
          });
          const rows = result.rows;
          return jsonResult({
            kind: "query" as const,
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
            // **測った事実**（上限＋1 行目が読めたか）。応答側で切ったかではない
            truncated: result.truncated
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

  /** CL を 1 本流して結果を返す（メッセージ系で共有する） */
  const runCommand = async (opts: Parameters<typeof openCommand>[0], command: string) => {
    const conn = await openCommand(opts);
    try {
      const r = await conn.run(command);
      return jsonResult({
        success: r.success,
        returnCode: r.returnCode,
        messages: r.messages.map((m) => ({ id: m.id, text: m.text, severity: m.severity, kind: m.kind }))
      });
    } finally {
      conn.close();
    }
  };

  // ---- コマンド / プログラム呼び出し ----

  /**
   * 呼び出し 1 引数のスキーマ。**数値も文字列でやり取りする**
   * ——`number` は 2^53 を超えると精度を失い、金額のような値が静かに誤る。
   */
  const programArgSchema = z.object({
    type: z.enum(["char", "packed", "zoned", "bin", "bytes", "null"]),
    /** 既定は `in` */
    dir: z.enum(["in", "out", "inout"]).optional(),
    /** `in` / `inout` に要る。**数値も文字列**。`bytes` は base64 */
    value: z.string().optional(),
    /** `char` / `bytes` のバイト長 */
    length: z.number().int().min(0).max(65535).optional(),
    /** `packed` / `zoned` の桁数と小数位 */
    digits: z.number().int().min(1).max(63).optional(),
    decimals: z.number().int().min(0).max(63).optional(),
    /** `bin` のバイト数 */
    bytes: z.union([z.literal(2), z.literal(4), z.literal(8)]).optional()
  });


  server.registerTool(
    "host_call_program",
    {
      description:
        "ホストサーバー経由で IBM i のプログラム（RPG / COBOL / QSYS の API 等）を呼ぶ。" +
        "画面を経由しないので、5250 の画面遷移を組まずに処理を呼べる。" +
        "**引数の書き方は 2 通り**——`args`（型で書く。推奨）か `params`（生バイトの base64）。" +
        "`args` なら文字は CCSID に従って符号化され、数値は詰め 10 進 / ゾーン 10 進 / 2 進へ変換される" +
        "（**数値も文字列で渡す**。number は大きな値で精度を失うため）。" +
        "型で表せない構造体は `args` の `bytes`（base64）で渡せる。" +
        "出力は要求した順に返り、**入力専用の位置は null**。" +
        "例: QSYS/QCMDEXC に char のコマンドと packed(15,5) の長さを渡す。",
      inputSchema: {
        ...targetShape,
        program: z.string(),
        library: z.string().describe("ライブラリー名。*LIBL も指定できる"),
        /** 型で書く引数（推奨）。`params` と同時に指定しない */
        args: z.array(programArgSchema).max(255).optional(),
        /** 生バイトの引数（base64）。**`args` を使うなら要らない** */
        params: z.array(programParamSchema).max(255).optional()
      },
      outputSchema: {
        success: z.boolean(),
        returnCode: z.number(),
        messages: z.array(messageSchema),
        /**
         * 要求順。出力でない位置は null。
         * **`args` なら型に従った値、`params` なら base64** ——入力の書き方に合わせる
         */
        outputs: z.array(z.string().nullable())
      }
    },
    async (input) =>
      withAudit({ op: "host_call_program" }, async () => {
        if (input.args && input.params) {
          return errorResult(
            new As400Error("CONFIG_ERROR", "args と params は同時に指定できません（どちらか一方）")
          );
        }
        const opts = target(input);
        const conn = await openCommand(opts);
        try {
          const ccsid = opts.ccsid ?? 37;
          const typed = input.args as ProgramArg[] | undefined;
          const { result, outputs } = await conn.call(
            input.program,
            input.library,
            typed
              ? toProgramParameters(typed, { ccsid })
              : toProgramParams(input.params ?? [])
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
            // **入力の書き方に出力を合わせる**（型で書いたなら型で返す）
            outputs: typed
              ? fromProgramOutputs(typed, outputs, { ccsid }).map((v) => v ?? null)
              : outputs.map((o) => (o ? Buffer.from(o).toString("base64") : null))
          });
        } finally {
          conn.close();
        }
      }).catch(errorResult)
  );

  server.registerTool(
    "host_call_service_program",
    {
      description:
        "ホストサーバー経由で**サービスプログラム（*SRVPGM）の手続き**を呼ぶ。" +
        "引数の書き方は host_call_program の args と同じで、**`pass` で渡し方を選べる**" +
        "（`reference` が既定 / `value` は値渡し。int などの小さな値で使う）。" +
        "`returns: \"int\"` を指定すると戻り値が returnValue に入る。" +
        "内部は QSYS/QZRUCLSP 経由——新しい電文は使っていない。",
      inputSchema: {
        ...targetShape,
        serviceProgram: z.string(),
        library: z.string().describe("ライブラリー名。*LIBL も指定できる"),
        procedure: z.string().max(4000).describe("公開されている手続き名（大文字小文字を区別する）。長い装飾名も通る"),
        returns: z.enum(["none", "int"]).optional(),
        args: z.array(programArgSchema.extend({ pass: z.enum(["reference", "value"]).optional() })).max(255).optional()
      },
      outputSchema: {
        success: z.boolean(),
        returnCode: z.number(),
        messages: z.array(messageSchema),
        /** `returns: "int"` のときだけ入る */
        returnValue: z.number().nullable().optional(),
        outputs: z.array(z.string().nullable())
      }
    },
    async (input) =>
      withAudit({ op: "host_call_service_program" }, async () => {
        const opts = target(input);
        const conn = await openCommand(opts);
        try {
          const ccsid = opts.ccsid ?? 37;
          const args = (input.args ?? []) as (ProgramArg & { pass?: "reference" | "value" })[];
          const params = toProgramParameters(args, { ccsid });
          const built = buildServiceProgramParams({
            serviceProgram: input.serviceProgram,
            library: input.library,
            procedure: input.procedure,
            ...(input.returns !== undefined ? { returns: input.returns } : {}),
            args: params.map((param, i) => ({
              param,
              ...(args[i]?.pass !== undefined ? { pass: args[i]!.pass! } : {})
            })),
            ccsid
          });
          const { result, outputs } = await conn.call("QZRUCLSP", "QSYS", built);
          const split = splitServiceProgramOutputs(outputs, args.length);
          return jsonResult({
            success: result.success,
            returnCode: result.returnCode,
            messages: result.messages.map((m) => ({
              id: m.id,
              text: m.text,
              severity: m.severity,
              kind: m.kind
            })),
            ...(input.returns === "int" ? { returnValue: split.returnValue ?? null } : {}),
            outputs: fromProgramOutputs(args, split.args, { ccsid }).map((v) => v ?? null)
          });
        } finally {
          conn.close();
        }
      }).catch(errorResult)
  );

  // ---- メッセージ待ち行列 ----

  const msgShape = { queue: z.string(), library: z.string().optional() };

  server.registerTool(
    "host_list_messages",
    {
      description:
        "メッセージ待ち行列のメッセージを一覧する（QSYSOPR など）。" +
        "**`onlyInquiry: true` で応答すべきものだけ**に絞れる——照会に応答しないとジョブが止まったままになる。" +
        "応答には `key`（16 進 8 桁）を host_reply_message へ渡す。",
      inputSchema: {
        ...targetShape,
        ...msgShape,
        max: z.number().int().min(1).max(500).optional(),
        onlyInquiry: z.boolean().optional()
      }
    },
    async (input) =>
      withAudit({ op: "host_list_messages" }, async () => {
        const opts = target(input);
        const db = await openDb(opts);
        try {
          const sql = buildListSql({
            queue: input.queue.toUpperCase(),
            library: (input.library ?? "*LIBL").toUpperCase(),
            ccsid: opts.ccsid ?? 37,
            max: input.max ?? 100,
            ...(input.onlyInquiry !== undefined ? { onlyInquiry: input.onlyInquiry } : {})
          });
          const q = await openQuery(db, sql);
          try {
            const rows = [];
            for await (const r of q.rows) rows.push(r);
            return jsonResult({ messages: rows });
          } finally {
            await q.close();
          }
        } finally {
          db.close();
        }
      }).catch(errorResult)
  );

  server.registerTool(
    "host_send_message",
    {
      description:
        "メッセージを送る。宛先は `toUser`（利用者）か `toQueue`（待ち行列）。" +
        "`inquiry: true` で照会（応答を待つ種別）にする——**待ち行列には 2 件入る**（SENDER と INQUIRY。IBM i の仕様）。",
      inputSchema: {
        ...targetShape,
        text: z.string().max(494),
        toUser: z.string().optional(),
        toQueue: z.string().optional(),
        toLibrary: z.string().optional(),
        inquiry: z.boolean().optional(),
        replyQueue: z.string().optional(),
        replyLibrary: z.string().optional()
      }
    },
    async (input) =>
      withAudit({ op: "host_send_message" }, async () => runCommand(target(input), buildSendCommand(input as never))).catch(
        errorResult
      )
  );

  server.registerTool(
    "host_reply_message",
    {
      description:
        "**照会メッセージに応答する。** `key` は host_list_messages が返す 16 進 8 桁。" +
        "同じ本文のメッセージが複数あっても、キーなら取り違えない。",
      inputSchema: { ...targetShape, ...msgShape, key: z.string(), reply: z.string().max(132) }
    },
    async (input) =>
      withAudit({ op: "host_reply_message" }, async () =>
        runCommand(target(input), buildReplyCommand(input as never))
      ).catch(errorResult)
  );

  server.registerTool(
    "host_remove_messages",
    {
      description:
        "メッセージを消す。`key` を指定すると 1 件、省略すると**全消し**。" +
        "**戻せない操作**なので、消す前に host_list_messages で確かめること。",
      inputSchema: { ...targetShape, ...msgShape, key: z.string().optional() }
    },
    async (input) =>
      withAudit({ op: "host_remove_messages" }, async () => {
        const opts = target(input);
        const queue = input.queue.toUpperCase();
        const library = (input.library ?? "*LIBL").toUpperCase();
        if (input.key === undefined || input.key.trim() === "") {
          return runCommand(opts, `CLRMSGQ MSGQ(${library}/${queue})`);
        }
        const conn = await openCommand(opts);
        try {
          // **`RMVMSG` は CL 内でしか使えない**ので API を直接呼ぶ
          const r = await removeByKey(conn, {
            queue,
            library,
            keyHex: input.key.toUpperCase(),
            ccsid: opts.ccsid ?? 37
          });
          return jsonResult({
            success: r.success,
            returnCode: r.returnCode,
            messages: r.messages.map((m: { id?: string; text?: string; severity?: number; kind?: string }) => ({
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
        "format=pages で論理ページごとに、text で全行をまとめて、" +
        "html で等幅・改ページを保った自己完結 HTML（人に見せる/残す用）を返す。",
      inputSchema: {
        ...targetShape,
        id: spoolIdSchema,
        format: z.enum(["text", "pages", "html"]).optional(),
        ccsid: z.number().int().optional(),
        /** html のときだけ使う見出し・注記 */
        title: z.string().optional(),
        note: z.string().optional()
      },
      outputSchema: {
        lines: z.array(z.string()).optional(),
        pages: z
          .array(z.object({ rows: z.number(), cols: z.number(), lines: z.array(z.string()) }))
          .optional(),
        html: z.string().optional(),
        bytes: z.number().optional()
      }
    },
    async (input) =>
      withAudit({ op: "host_get_spool" }, async () => {
        // HTTP ルートと同じ共有関数を通す（spec 方針1）。
        // text 形式は論理ページを平坦化するだけ——core の readSpooledText と同じ扱い
        const pages = await readSpoolPages(target(input), input.id, input.ccsid);
        if (input.format === "pages") return jsonResult({ pages });
        if (input.format === "html") {
          // 描画は push 型の get_spool_html と**同じ関数**を通す（帳票の絵を 2 つ持たない）
          const html = renderSpoolHtml(
            pages,
            {
              capturedAt: new Date().toISOString(),
              spoolId: `${input.id.fileName}/${input.id.jobName}/${input.id.fileNumber}`,
              ...(input.title !== undefined ? { title: input.title } : {}),
              ...(input.note !== undefined ? { note: input.note } : {})
            },
            // 復号に使った CCSID から、そのままの字がどちらの読みかを決める
            { sbcs: { host: isKatakanaCcsid(input.ccsid) ? "kana" : "latin" } }
          );
          return jsonResult({ html, bytes: html.length });
        }
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

  // ---- データ待ち行列（DTAQ） ----

  const dtaqEncoding = z.enum(["utf8", "base64", "ebcdic"]);
  const dtaqName = z.string().min(1).max(10);

  server.registerTool(
    "host_dtaq_send",
    {
      description:
        "データ待ち行列にエントリを積む。data は encoding で解釈（utf8=テキスト / base64=バイナリ / " +
        "ebcdic=システムキュー）。キー付きキューには key を付ける。",
      inputSchema: {
        ...targetShape,
        library: dtaqName,
        name: dtaqName,
        data: z.string(),
        encoding: dtaqEncoding.optional(),
        key: z.string().optional(),
        keyEncoding: dtaqEncoding.optional()
      },
      outputSchema: { ok: z.boolean() }
    },
    async (input) =>
      withAudit({ op: "host_dtaq_send" }, async () => {
        const conn = await openDtaq(target(input));
        try {
          const entry = toBytes(input.data, input.encoding ?? "utf8");
          const key = input.key !== undefined ? toBytes(input.key, input.keyEncoding ?? "utf8") : undefined;
          await conn.write(input.name, input.library, entry, key);
          return jsonResult({ ok: true });
        } finally {
          conn.close();
        }
      }).catch(errorResult)
  );

  server.registerTool(
    "host_dtaq_receive",
    {
      description:
        "データ待ち行列からエントリを取り出す／覗く（peek）。空なら entry=null（エラーではない）。" +
        "wait は待機秒（0=待たない）。**無限待ちは MCP からは不可**（上限でクランプ）。" +
        "キー付きは key と search（EQ/NE/LT/LE/GT/GE）。entry.data は encoding で返す。",
      inputSchema: {
        ...targetShape,
        library: dtaqName,
        name: dtaqName,
        wait: z.number().int().min(0).optional(),
        peek: z.boolean().optional(),
        key: z.string().optional(),
        keyEncoding: dtaqEncoding.optional(),
        search: z.enum(["EQ", "NE", "LT", "LE", "GT", "GE"]).optional(),
        encoding: dtaqEncoding.optional()
      },
      outputSchema: {
        entry: z
          .object({
            data: z.string(),
            encoding: z.string(),
            bytes: z.number(),
            senderInfo: z.string().optional()
          })
          .nullable()
      }
    },
    async (input) =>
      withAudit({ op: "host_dtaq_receive" }, async () => {
        const conn = await openDtaq(target(input));
        try {
          const encoding = input.encoding ?? "utf8";
          // HTTP ルートと同じ上限を効かせる（`--dtaq-max-wait` で締めた値を MCP でも尊重）
          const wait = Math.min(input.wait ?? 0, deps.dtaqReceiveMaxWaitSec ?? DEFAULT_DTAQ_RECEIVE_MAX_WAIT_SEC);
          const key = input.key !== undefined ? toBytes(input.key, input.keyEncoding ?? "utf8") : undefined;
          const entry = await conn.read({
            name: input.name,
            library: input.library,
            wait,
            ...(input.peek !== undefined ? { peek: input.peek } : {}),
            ...(key !== undefined ? { key } : {}),
            ...(input.search !== undefined ? { search: input.search } : {})
          });
          if (entry === undefined) return jsonResult({ entry: null });
          return jsonResult({
            entry: {
              data: fromBytes(entry.data, encoding),
              encoding,
              bytes: entry.data.length,
              ...(entry.senderInfo !== undefined ? { senderInfo: dtaqDecodeEbcdic(entry.senderInfo) } : {})
            }
          });
        } finally {
          conn.close();
        }
      }).catch(errorResult)
  );

  server.registerTool(
    "host_dtaq_create",
    {
      description:
        "データ待ち行列を作る。type は FIFO / LIFO / KEYED。KEYED なら keyLength が要る。",
      inputSchema: {
        ...targetShape,
        library: dtaqName,
        name: dtaqName,
        maxEntryLength: z.number().int().min(1).max(64512),
        type: z.enum(["FIFO", "LIFO", "KEYED"]),
        keyLength: z.number().int().min(1).max(256).optional(),
        saveSender: z.boolean().optional(),
        description: z.string().max(50).optional()
      },
      outputSchema: { ok: z.boolean() }
    },
    async (input) =>
      withAudit({ op: "host_dtaq_create" }, async () => {
        // HTTP ルートと同じ整合チェック（両サーフェスで同一に弾く）
        if (input.type === "KEYED" && input.keyLength === undefined) {
          throw new As400Error("CONFIG_ERROR", "KEYED のキューには keyLength が必要です");
        }
        if (input.type !== "KEYED" && input.keyLength !== undefined) {
          throw new As400Error("CONFIG_ERROR", "keyLength は KEYED のときだけ指定できます");
        }
        const conn = await openDtaq(target(input));
        try {
          await conn.create({
            name: input.name,
            library: input.library,
            maxEntryLength: input.maxEntryLength,
            type: input.type,
            ...(input.keyLength !== undefined ? { keyLength: input.keyLength } : {}),
            ...(input.saveSender !== undefined ? { saveSender: input.saveSender } : {}),
            ...(input.description !== undefined ? { description: input.description } : {})
          });
          return jsonResult({ ok: true });
        } finally {
          conn.close();
        }
      }).catch(errorResult)
  );

  server.registerTool(
    "host_dtaq_clear",
    {
      description: "データ待ち行列のエントリを全消去する（キー付きは key で特定キーだけも可）。",
      inputSchema: {
        ...targetShape,
        library: dtaqName,
        name: dtaqName,
        key: z.string().optional(),
        keyEncoding: dtaqEncoding.optional()
      },
      outputSchema: { ok: z.boolean() }
    },
    async (input) =>
      withAudit({ op: "host_dtaq_clear" }, async () => {
        const conn = await openDtaq(target(input));
        try {
          const key = input.key !== undefined ? toBytes(input.key, input.keyEncoding ?? "utf8") : undefined;
          await conn.clear(input.name, input.library, key);
          return jsonResult({ ok: true });
        } finally {
          conn.close();
        }
      }).catch(errorResult)
  );

  server.registerTool(
    "host_dtaq_delete",
    {
      description: "データ待ち行列を削除する（DLTDTAQ 相当）。",
      inputSchema: { ...targetShape, library: dtaqName, name: dtaqName },
      outputSchema: { ok: z.boolean() }
    },
    async (input) =>
      withAudit({ op: "host_dtaq_delete" }, async () => {
        const conn = await openDtaq(target(input));
        try {
          await conn.deleteQueue(input.name, input.library);
          return jsonResult({ ok: true });
        } finally {
          conn.close();
        }
      }).catch(errorResult)
  );

  server.registerTool(
    "host_dtaq_attributes",
    {
      description: "データ待ち行列の属性を取得する（最大エントリ長・種別・キー長・送信者情報の保存）。",
      inputSchema: { ...targetShape, library: dtaqName, name: dtaqName },
      outputSchema: {
        maxEntryLength: z.number(),
        type: z.string(),
        keyLength: z.number(),
        saveSender: z.boolean()
      }
    },
    async (input) =>
      withAudit({ op: "host_dtaq_attributes" }, async () => {
        const conn = await openDtaq(target(input));
        try {
          return jsonResult({ ...(await conn.attributes(input.name, input.library)) });
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

  // ---- 実行計画（Visual Explain 相当） ----

  /**
   * 計画を MCP へ返す形に畳む。
   *
   * **表を丸ごと返さない。** ノードは既定 50 件までにし、切ったことは `truncated` で示す
   * （黙って切ると「これで全部」と読まれる）。属性は `detail` を指定したときだけ載せる
   * ——1 ノードあたり最大 10 項目あり、既定で付けると文脈を食い潰す。
   */
  const MAX_PLAN_NODES = 50;
  /**
   * 結合の順を平らな配列にする。**画面と同じ情報を MCP にも返す**
   * （図でしか分からない、を作らない）。左深なので「ここまでのダイヤル」＋「足すダイヤル」で表せる。
   */
  const joinStepsOf = (plan: QueryPlan) => {
    const out: {
      block: number;
      step: "join" | "table-probe" | "final-select";
      label: string;
      joined?: number[];
      with?: number;
      rows?: number;
    }[] = [];
    for (const b of plan.blocks) {
      // 左深なので根から左（＝下から上）へ降りて、集めた順をひっくり返す
      const spine: PlanTreeNode[] = [];
      let cur = b.joinTree;
      while (cur && cur.kind !== "dial") {
        spine.unshift(cur);
        cur = cur.kind === "join" ? cur.left : cur.source;
      }
      const acc: number[] = cur?.kind === "dial" ? [cur.position] : [];
      for (const item of spine) {
        if (item.kind === "join") {
          if (item.right.kind !== "dial") break;
          out.push({ block: b.number, step: "join", label: item.label, joined: [...acc], with: item.right.position });
          acc.push(item.right.position);
        } else if (item.kind === "op") {
          out.push({
            block: b.number,
            step: item.op,
            label: item.label,
            ...(item.rows !== undefined ? { rows: item.rows } : {})
          });
        }
      }
    }
    return out;
  };
  const toPlanJson = (plan: QueryPlan, detail: boolean) => {
    const flat = plan.blocks.flatMap((b) => b.nodes.map((n) => ({ block: b.number, node: n })));
    const shown = flat.slice(0, MAX_PLAN_NODES);
    return {
      statement: plan.statement,
      captured: plan.captured,
      at: plan.at,
      ...(plan.job ? { job: plan.job } : {}),
      summary: plan.summary,
      nodes: shown.map(({ block, node }) => ({
        block,
        kind: node.kind,
        recordType: node.recordType,
        label: node.label,
        ...(node.table ? { table: `${node.table.schema}.${node.table.name}` } : {}),
        ...(node.index ? { index: node.index.name } : {}),
        ...(node.totalRows !== undefined ? { totalRows: node.totalRows } : {}),
        ...(node.estimatedRows !== undefined ? { estimatedRows: node.estimatedRows } : {}),
        ...(node.estimatedMs !== undefined ? { estimatedMs: node.estimatedMs } : {}),
        ...(node.reasonCode ? { reasonCode: node.reasonCode } : {}),
        // 結合の位置（ダイヤル）。**どの表がどの順で重なるか**はこれと `joins` で分かる
        ...(node.joinPosition !== undefined ? { joinPosition: node.joinPosition } : {}),
        // **列名のままの属性は返さない。** 1 ノードで 90 項目を超え、
        // 意味を確かめていない列名（`QQI9=183`）は読む側の役に立たないまま文脈を食う。
        // 画面では出している（人は ACS と突き合わせられる）
        ...(detail ? { attributes: node.attributes.filter((a) => !a.raw) } : {})
      })),
      nodeCount: flat.length,
      truncated: flat.length > shown.length,
      advice: plan.advice.map((a) => ({
        table: `${a.table.schema}.${a.table.name}`,
        keyColumns: a.keyColumns,
        createStatement: a.createStatement,
        ...(a.totalRows !== undefined ? { totalRows: a.totalRows } : {})
      })),
      /**
       * 結合とその後の処理を上から順に並べたもの（`QQJNP` のダイヤル順に左深）。
       * `table-probe`（索引だけでは足りず表から取り直す）と `final-select`（返した行数）を含む。
       * **結合していない計画では空**。
       * ⚠ **内部/外部は載せない**——`QQC22` は `LEFT OUTER JOIN` でも `IN` を返す（実測）。
       */
      joins: joinStepsOf(plan),
      /** **未対応の記録種別を黙って捨てない**（版数差がここに出る。7.5 の 3015 等） */
      unknownRecordTypes: plan.unknownRecordTypes
    };
  };

  server.registerTool(
    "host_sql_explain",
    {
      description:
        "SQL の実行計画（アクセスプラン）を採って返す。遅い SQL の原因（表全体の走査・索引の未使用・" +
        "推定行数と実測の乖離）を調べるために使う。" +
        "**自ジョブの DB モニターで採るので特殊権限は要らない。**" +
        "mode=run は文を実行してから計画を採る。mode=no-rows は結果行を返さずに計画だけ採る" +
        "（**文はホストで実行される**——「実行しない」ではない。SELECT 系のみ）。" +
        "**IBM i には『実行せずに計画だけ』の経路が無い**ため、UPDATE/DELETE を安全に調べることはできない。" +
        "**既定は no-rows**——更新系の文は既定では拒否され、調べるには mode=run を明示して" +
        "実際に実行する必要がある（取り消せないので呼ぶ側が明示的に選ぶ）。" +
        "推奨インデックスがあれば advice に CREATE INDEX 文まで入れて返す（実行はしない）。",
      inputSchema: {
        ...targetShape,
        sql: z.string(),
        mode: z.enum(["run", "no-rows"]).optional(),
        maxRows: z.number().int().positive().max(MAX_LIMIT).optional(),
        /** ノードごとの属性まで返す。既定は返さない（トークン量を抑える） */
        detail: z.boolean().optional()
      },
      // **返す欄をすべて宣言する。** MCP SDK は structuredContent を outputSchema で
      // **厳密に検証**し、宣言されていない欄が 1 つでもあると
      // `Structured content does not match the tool's output schema` で呼び出しごと落ちる。
      // `captured` / `at` / `job` / `warnings` の宣言漏れで実際に落ちた（実機の MCP 検証で判明）。
      outputSchema: {
        statement: z.string(),
        captured: z.string(),
        at: z.string(),
        job: z.string().optional(),
        summary: z.record(z.string(), z.unknown()),
        nodes: z.array(z.record(z.string(), z.unknown())),
        nodeCount: z.number(),
        truncated: z.boolean(),
        advice: z.array(z.record(z.string(), z.unknown())),
        // **宣言漏れは呼び出しごと落ちる**（上の注記）。結合の順もここに足す
        joins: z.array(z.record(z.string(), z.unknown())),
        unknownRecordTypes: z.array(z.number()),
        warnings: z.array(z.string()).optional()
      }
    },
    async (input) =>
      withAudit({ op: "host_sql_explain" }, async () => {
        const conn = await openDb(target(input));
        try {
          const captured = await capturePlan(conn, input.sql, {
            // **既定は no-rows。** run を既定にすると「この DELETE を explain して」で
            // **本当に削除が走る**。行を返さない側を既定にすれば、更新系は
            // `capturePlan` に拒否され、実行するには呼ぶ側が mode=run を明示することになる
            mode: input.mode ?? "no-rows",
            limit: input.maxRows ?? 200,
            at: new Date().toISOString()
          });
          return jsonResult({
            ...toPlanJson(captured.plan, input.detail ?? false),
            ...(captured.warnings.length > 0 ? { warnings: captured.warnings } : {})
          });
        } finally {
          conn.close();
        }
      }).catch(errorResult)
  );

  server.registerTool(
    "host_plan_list",
    {
      description:
        "プランキャッシュ（システム上に残っている実行計画）の上位 N を実行時間順に一覧する。" +
        "自分が流していない SQL も見えるので、遅い処理を探すのに使う。" +
        "**特殊権限（*JOBCTL 等）が要る。** 権限が無い接続では available:false と理由を返す" +
        "（エラーにはしない）。個々の計画の中身は host_sql_explain とは別経路なので、" +
        "ここでは文テキストと対象表までを返す。",
      inputSchema: { ...targetShape, topN: z.number().int().positive().max(100).optional() },
      outputSchema: {
        available: z.boolean(),
        reason: z.string().optional(),
        items: z.array(z.record(z.string(), z.unknown())),
        count: z.number()
      }
    },
    async (input) =>
      withAudit({ op: "host_plan_list" }, async () => {
        const conn = await openDb(target(input));
        try {
          const result = await listPlansFromCache(conn, input.topN ?? 20);
          return jsonResult({
            available: result.available,
            ...(result.reason ? { reason: result.reason } : {}),
            items: result.items,
            count: result.items.length
          });
        } finally {
          conn.close();
        }
      }).catch(errorResult)
  );
}
