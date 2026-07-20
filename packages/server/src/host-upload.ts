/**
 * CSV 取り込みの API（DDM でレコードを追記する）。
 *
 * ⚠ **このルートは IBM i に書き込む。** `host-sql.ts` の冒頭が説明している
 * 「構造的に読み取り専用」という性質は `/api/host/sql` に限った話で、
 * ホスト API 全体の不変条件ではない（同ファイルの警告に対する再検討の結論。design DD6）。
 *
 * 認可は他のホスト API と同じく「接続を持つユーザーなら誰でも」。
 * **書ける範囲は IBM i 側のオブジェクト権限が決める**——アプリ側で追加の制限を掛けると、
 * ホストで許された操作を UI が勝手に禁じることになり、既存の設計思想と食い違う。
 *
 * ⚠ **DDM にはコミットメント制御が無い。** 途中で失敗しても書けた分は残る。
 * よって「何行目まで確定したか」を返すことが仕様上の要求になっている。
 */
import { Hono } from "hono";
import { z } from "zod";
import {
  As400Error,
  InsertEncodeError,
  assertIdentifier,
  fetchColumnLayout,
  insertRows,
  parseCsv,
  prepareUpload,
  childLog,
  type ConnectOptions,
  type UploadRejection
} from "@as400web/core";
import type { AuthVars } from "./auth.js";
import type { ConfigResolver } from "./config-resolver.js";
import { openDb } from "./host-connect.js";
import { resolveSource, sourceSchema, statusOf } from "./host-api.js";

const log = childLog({ component: "host-upload" });

/**
 * 1 回に受け付ける行数の上限。**サーバー側で強制する**（UI の出し分けに依存しない）。
 *
 * 事前検査は全行をメモリ上で符号化してから送るため（design DD2）、
 * 上限が無いと 1 リクエストで青天井にメモリを掴む。
 */
const MAX_ROWS = 10_000;
/** CSV 文字列で受ける場合の上限（MCP 経由）。おおよそ MAX_ROWS 相当を見込む */
const MAX_CSV_BYTES = 8 * 1024 * 1024;

const uploadRequestSchema = z
  .object({
    source: sourceSchema,
    library: z.string().min(1),
    file: z.string().min(1),
    /** CSV のヘッダー（表の列名と対応づける） */
    columns: z.array(z.string()).min(1),
    /** 値。型変換はサーバーが列型に従って行う */
    rows: z.array(z.array(z.string().nullable())).max(MAX_ROWS),
    /** 空文字を NULL として扱うか（既定 false） */
    emptyAsNull: z.boolean().optional()
  })
  .strict();

export interface HostUploadDeps {
  resolver: ConfigResolver;
}

export interface UploadArgs {
  opts: ConnectOptions;
  library: string;
  file: string;
  header: readonly string[];
  rows: readonly (readonly (string | null)[])[];
  emptyAsNull?: boolean;
}

export type UploadOutcome =
  | {
      ok: true;
      committedRows: number;
      uncertainRange?: { from: number; to: number };
      /** 途中で失敗した理由。**巻き戻せない書き込みでは最も重要な情報**なので必ず返す */
      error?: string;
      batchSize: number;
      ms: number;
    }
  | { ok: false; rejections: UploadRejection[]; truncated: boolean };

/**
 * 取り込みの**唯一の実行経路**。HTTP ルートも MCP ツールもここを通す。
 * 入口ごとに検査や順序が分岐すると、片方だけ緩い経路ができる（design）。
 *
 * 順番だけを持ち、判断は core の純関数（`prepareUpload`）に委ねる。
 */
export async function uploadRows(args: UploadArgs): Promise<UploadOutcome> {
  // **上限はここで強制する**。HTTP の zod にだけ置くと MCP の columns+rows 経路が素通りし、
  // 全行をメモリ上に持つため OOM の入口になる
  if (args.rows.length > MAX_ROWS) {
    throw new As400Error("CONFIG_ERROR", `行数が多すぎます（上限 ${MAX_ROWS} 行）`);
  }
  const library = assertIdentifier(args.library, "ライブラリ名");
  const file = assertIdentifier(args.file, "ファイル名");
  const started = Date.now();

  // **1 接続を借りて最後まで使う**。`insertRows` は準備〜実行を 1 操作として行うため、
  // その間に別の SQL を流すと同じ RPB の文が上書きされて失われる（core の説明を参照）
  const db = await openDb(args.opts);
  try {
    // --- 1. 列メタデータ（列名と NULL 可否の突き合わせに使う）---
    const columns = await fetchColumnLayout(db, library, file);

    // --- 2. 事前検査。**通るまで 1 行も書かない** ---
    const prepared = prepareUpload({
      columns,
      header: args.header,
      rows: args.rows,
      ...(args.emptyAsNull !== undefined ? { emptyAsNull: args.emptyAsNull } : {})
    });
    if (!prepared.ok) {
      return { ok: false, rejections: prepared.rejections, truncated: prepared.truncated };
    }

    // --- 3. 書く ---
    try {
      const res = await insertRows(db, {
        library,
        table: file,
        columns: prepared.prepared.columns,
        rows: prepared.prepared.rows
      });
      if (res.uncertainRange) {
        log.warn(
          `partial upload into ${library}.${file}: committed=${res.committedRows} ` +
            `uncertain=${res.uncertainRange.from}-${res.uncertainRange.to}: ${res.error ?? "(理由不明)"}`
        );
      } else {
        log.debug(
          `uploaded ${res.committedRows} rows into ${library}.${file} batch=${res.batchSize}`
        );
      }
      return {
        ok: true,
        committedRows: res.committedRows,
        ...(res.uncertainRange ? { uncertainRange: res.uncertainRange } : {}),
        ...(res.error !== undefined ? { error: res.error } : {}),
        batchSize: res.batchSize,
        ms: Date.now() - started
      };
    } catch (e) {
      // 値を詰められなかった行は**拒否として返す**（1 行も書いていない）
      if (e instanceof InsertEncodeError) {
        const column = prepared.prepared.columns[e.columnIndex] ?? `列${e.columnIndex + 1}`;
        return {
          ok: false,
          rejections: [{ kind: "value-invalid", row: e.row, column, reason: e.message }],
          truncated: false
        };
      }
      throw e;
    }
  } finally {
    db.close();
  }
}

/** CSV 文字列から取り込む（MCP の受け口。解析は core の同じ実装を使う） */
export async function uploadCsv(
  args: Omit<UploadArgs, "header" | "rows"> & { csv: string }
): Promise<UploadOutcome> {
  if (args.csv.length > MAX_CSV_BYTES) {
    throw new As400Error("CONFIG_ERROR", `CSV が大きすぎます（上限 ${MAX_CSV_BYTES} バイト）`);
  }
  const { header, rows } = parseCsv(args.csv);
  if (rows.length > MAX_ROWS) {
    throw new As400Error("CONFIG_ERROR", `行数が多すぎます（上限 ${MAX_ROWS} 行）`);
  }
  return uploadRows({ ...args, header, rows });
}

export function registerHostUploadRoutes(
  app: Hono<{ Variables: AuthVars }>,
  deps: HostUploadDeps
): void {
  app.post("/api/host/upload", async (c) => {
    const parsed = uploadRequestSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message ?? "invalid request" }, 400);
    }
    const { source, library, file, columns, rows, emptyAsNull } = parsed.data;
    const user = c.get("user");
    try {
      const opts = resolveSource(deps.resolver, source, user);
      const outcome = await uploadRows({
        opts,
        library,
        file,
        header: columns,
        rows,
        ...(emptyAsNull !== undefined ? { emptyAsNull } : {})
      });
      if (!outcome.ok) {
        // **1 行も書いていない**ことを利用者側の入力の問題として返す
        return c.json(
          { error: "取り込めませんでした", code: "UPLOAD_REJECTED", ...outcome },
          400
        );
      }
      return c.json(outcome);
    } catch (e) {
      const err = e as As400Error;
      return c.json({ error: err.message, code: err.code ?? "UNKNOWN" }, statusOf(err));
    }
  });
}
