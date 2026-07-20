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
  DdmConnection,
  assertIdentifier,
  fetchColumnLayout,
  parseCsv,
  prepareUpload,
  childLog,
  type ConnectOptions,
  type UploadRejection
} from "@as400web/core";
import type { AuthVars } from "./auth.js";
import type { ConfigResolver } from "./config-resolver.js";
import { openDb, hostAuthFrom } from "./host-connect.js";
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
    member: z.string().min(1).optional(),
    /** CSV のヘッダー（表の列名と対応づける） */
    columns: z.array(z.string()).min(1),
    /** 値。型変換はサーバーが列型に従って行う */
    rows: z.array(z.array(z.string().nullable())).max(MAX_ROWS),
    /** 1 バッチの希望件数。実効値は recordIncrement で丸める */
    blockingFactor: z.number().int().positive().optional(),
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
  member?: string;
  header: readonly string[];
  rows: readonly (readonly (string | null)[])[];
  blockingFactor?: number;
  emptyAsNull?: boolean;
}

export type UploadOutcome =
  | {
      ok: true;
      committedRows: number;
      uncertainRange?: { from: number; to: number };
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
export async function uploadRows(deps: HostUploadDeps, args: UploadArgs): Promise<UploadOutcome> {
  const library = assertIdentifier(args.library, "ライブラリ名");
  const file = assertIdentifier(args.file, "ファイル名");
  const started = Date.now();

  // --- 1. 列メタデータ（型・長さ・位取り・CCSID）---
  const db = await openDb(args.opts);
  let columns;
  try {
    columns = await fetchColumnLayout(db, library, file);
  } finally {
    db.close();
  }

  // --- 2. 事前検査。**ここを通るまで DDM に接続しない** ---
  // 接続してから拒否すると、無駄に 4〜7 秒待たせたうえで「1 行も書いていない」と返すことになる
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
  const ddm = await DdmConnection.connect(hostAuthFrom(args.opts));
  try {
    const opened = await ddm.open(library, file, {
      ...(args.member !== undefined ? { member: args.member } : {}),
      ...(args.blockingFactor !== undefined ? { blockingFactor: args.blockingFactor } : {})
    });

    // **レイアウト計算は仮説に基づく実装**（`record-layout.ts` が自らそう明記している）。
    // ホスト申告との一致がその唯一の裏付けなので、テストではなく実行時にも確かめる
    if (opened.recordLength !== prepared.layout.recordLength) {
      throw new As400Error(
        "PROTOCOL_ERROR",
        `レコード長が一致しません（SQL 由来 ${prepared.layout.recordLength} / ` +
          `ホスト申告 ${opened.recordLength}）。レイアウト計算の前提が崩れています`
      );
    }

    const res = await ddm.writeAll(opened, prepared.records);
    await ddm.close(opened);
    log.debug(
      `uploaded ${res.committedRows}/${prepared.records.length} rows into ${library}/${file} ` +
        `batch=${opened.effectiveBatchSize}`
    );
    return {
      ok: true,
      committedRows: res.committedRows,
      ...(res.uncertainRange ? { uncertainRange: res.uncertainRange } : {}),
      batchSize: opened.effectiveBatchSize,
      ms: Date.now() - started
    };
  } finally {
    ddm.disconnect();
  }
}

/** CSV 文字列から取り込む（MCP の受け口。解析は core の同じ実装を使う） */
export async function uploadCsv(
  deps: HostUploadDeps,
  args: Omit<UploadArgs, "header" | "rows"> & { csv: string }
): Promise<UploadOutcome> {
  if (args.csv.length > MAX_CSV_BYTES) {
    throw new As400Error("CONFIG_ERROR", `CSV が大きすぎます（上限 ${MAX_CSV_BYTES} バイト）`);
  }
  const { header, rows } = parseCsv(args.csv);
  if (rows.length > MAX_ROWS) {
    throw new As400Error("CONFIG_ERROR", `行数が多すぎます（上限 ${MAX_ROWS} 行）`);
  }
  return uploadRows(deps, { ...args, header, rows });
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
    const { source, library, file, member, columns, rows, blockingFactor, emptyAsNull } =
      parsed.data;
    const user = c.get("user");
    try {
      const opts = resolveSource(deps.resolver, source, user);
      const outcome = await uploadRows(deps, {
        opts,
        library,
        file,
        ...(member !== undefined ? { member } : {}),
        header: columns,
        rows,
        ...(blockingFactor !== undefined ? { blockingFactor } : {}),
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
