/**
 * 実行計画の採取——**自ジョブの DB モニターを使う**。
 *
 * ## なぜこの経路か
 *
 * `20260802-sql-visual-explain` の research で、SQL ホストサーバー経由で計画を採る道を測った。
 *
 * - **`explain only`（文を実行せずに計画だけ）は実現できない**（research F7）。
 *   prepare だけでは最適化記録が **0 件**、完全実行では 18 件。最適化は `open` の時点で起きる。
 *   ACS 内部と思われる `QSYS2.PROCESS_DETAILED_MONITOR` も 7 通りすべて `-443/42815` で、
 *   文書化された入口も見つからなかった。
 * - **プランキャッシュ（`DUMP_PLAN_CACHE_TOPN`）は特権が要る**（research F15。PUB400 で `-443/38501`）。
 * - **自ジョブの DB モニターは特権不要**（research F14）。`STRDBMON JOB(*)` は
 *   **その SQL 接続のジョブ自身**を指すので、他ジョブを監視する権限が要らない。
 *   特殊権限を持たない PUB400 の利用者でも通った。
 *
 * → **主経路はこれ**。「自分が書いた SQL の計画を見る」は全利用者に提供できる。
 *
 * ## 手順と不変条件
 *
 * ```
 * ENDDBMON（残骸掃除・失敗は無視）
 * STRDBMON OUTFILE(QTEMP/一意名) JOB(*) TYPE(*DETAIL)
 * 対象の文（run は fetch まで / no-rows は open して即閉じる）
 * ENDDBMON                     ← finally。**必ず通す**
 * SELECT 明示列 FROM QTEMP/一意名
 * DROP TABLE                   ← finally。**必ず通す**
 * ```
 *
 * - **`STRDBMON` が失敗したら文を実行しない。** 計画が採れないのに副作用だけ起こすのは最悪。
 * - **`SELECT *` を使わない。** 表は 282 列あり、うち 3 列が CCSID 65535（research F8）。
 *   列を明示すれば避けられるうえ、要らない列を運ばずに済む。
 * - **この関数は接続を専有する。** モニター中に他の SQL を同じ接続へ流すと巻き込む。
 *   呼び出し側は explain 専用のプールキーを使うこと（`host-plan.ts`）。
 */
import { As400Error } from "@ts5250/base";
import { childLog } from "@ts5250/base";
import type { DbConnection } from "./db-connection.js";
import type { ColumnMeta, DbValue } from "./db-decode.js";
import { executeStatement } from "./execute.js";
import { openQuery, queryLimited, type LobOptions, type Row } from "./query.js";
import { isNonQueryStatement } from "./statement-kind.js";
import { monitorColumnLabels } from "./plan-column-text.js";
import {
  buildQueryPlan,
  pickStatementRecords,
  pickAllStatements,
  MONITOR_COLUMNS,
  type MonitorRecord,
  type QueryPlan
} from "./plan-model.js";

const log = childLog({ component: "hostserver-plan-capture" });

/** 採取モード。`explain only` は提供できない（research F7）ので 2 つだけ */
export type CaptureMode = "run" | "no-rows";

export interface CaptureOptions {
  mode: CaptureMode;
  /** `run` のときの取得上限 */
  limit?: number;
  lob?: LobOptions;
  /** 採取時刻。**純関数側に時計を持ち込まない**ため呼び出し側から渡す */
  at: string;
}

export interface CaptureResult {
  plan: QueryPlan;
  /**
   * 同じ採取に含まれる**他の文の計画**（実行順）。組が 1 つのときは付かない。
   * 手続きの `CALL` は中のカーソルごとに別の組になるので、ここに 2 本目以降が入る。
   * **`plan` はそのまま**——既存の保存済み JSON・実行履歴の形を変えないため。
   */
  plans?: QueryPlan[];
  /**
   * `plans` の中で `plan` と同じ記録から作られたものの位置。
   * **文テキストでは突き合わせられない**——`plan` は利用者が書いた文（`CALL …`）を名乗り、
   * `plans` の要素は中のカーソルの文を名乗るため。画面はこれを初期選択にする。
   */
  primaryIndex?: number;
  /** `run` のときだけ。`no-rows` では返さない */
  rows?: Row[];
  columns?: ColumnMeta[];
  /** 取得上限で打ち切ったか */
  truncated?: boolean;
  /**
   * 採取そのものは成功したが伝えるべきこと。
   * **`ENDDBMON` の失敗はここに入る**——記録は採れているので失敗にはしないが、
   * モニターが残った可能性は黙らない。
   */
  warnings: string[];
}

/**
 * QTEMP に作るモニター表の名前。**システム名の上限 10 文字**に収める。
 *
 * 採取ごとに変える——前回の残骸（`ENDDBMON` が届かずに残った表）と衝突させないため。
 * 一意性の種は呼び出し側から渡す（この層に時計を持ち込まないのと同じ理由で、
 * テストから決定的に固定できるようにする）。
 */
export function monitorTableName(seed: number): string {
  const s = Math.abs(Math.trunc(seed)).toString(36).toUpperCase().slice(-7);
  return `VEP${s.padStart(7, "0")}`;
}

/** `QSYS2.QCMDEXC` 経由で CL を投げる。CL 中の `'` は 2 つに増やす */
async function runCl(conn: DbConnection, command: string): Promise<void> {
  await executeStatement(conn, `CALL QSYS2.QCMDEXC('${command.replace(/'/gu, "''")}')`);
}

/** 前回の残骸を掃除する。**動いていなければエラーになるので無視する** */
async function endMonitorQuietly(conn: DbConnection): Promise<void> {
  try {
    await runCl(conn, "ENDDBMON JOB(*)");
  } catch (e) {
    log.debug(`ENDDBMON (cleanup) ignored: ${String(e)}`);
  }
}

/** 表を落とす。**失敗しても結果を捨てない**（QTEMP なので接続を閉じれば消える） */
async function dropQuietly(conn: DbConnection, table: string): Promise<void> {
  try {
    await executeStatement(conn, `DROP TABLE QTEMP.${table}`);
  } catch (e) {
    log.debug(`DROP TABLE QTEMP.${table} ignored: ${String(e)}`);
  }
}

function asNumber(v: DbValue): number | null {
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  // DECIMAL / NUMERIC は文字列で来る（`db-decimal.ts`）
  if (typeof v === "string") {
    const n = Number(v.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function asText(v: DbValue): string | null {
  return typeof v === "string" ? v : null;
}

/** 生の列として持つ値。数値と文字だけ（日付等は文字に落ちてくる） */
function rawValue(v: DbValue): string | number | null {
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string") {
    const t = v.trim();
    return t === "" ? null : t;
  }
  return null;
}

/** 読み出した行をモニター記録に写す。**`SELECT` した列だけを見る** */
function toRecord(row: Row): MonitorRecord {
  return {
    QQRID: asNumber(row["QQRID"] ?? null) ?? 0,
    QQUCNT: asNumber(row["QQUCNT"] ?? null),
    QQQDTN: asNumber(row["QQQDTN"] ?? null),
    QQQDTL: asNumber(row["QQQDTL"] ?? null),
    QQ1000: asText(row["QQ1000"] ?? null),
    QVQTBL: asText(row["QVQTBL"] ?? null),
    QVQLIB: asText(row["QVQLIB"] ?? null),
    QVINAM: asText(row["QVINAM"] ?? null),
    QVILIB: asText(row["QVILIB"] ?? null),
    QQTOTR: asNumber(row["QQTOTR"] ?? null),
    QQREST: asNumber(row["QQREST"] ?? null),
    QQEPT: asNumber(row["QQEPT"] ?? null),
    QQIDXA: asText(row["QQIDXA"] ?? null),
    QQIDXD: asText(row["QQIDXD"] ?? null),
    QQRCOD: asText(row["QQRCOD"] ?? null),
    QQJOB: asText(row["QQJOB"] ?? null),
    QQJNP: asNumber(row["QQJNP"] ?? null),
    QQC21: asText(row["QQC21"] ?? null),
    QVC14: asText(row["QVC14"] ?? null),
    QQILNM: asText(row["QQILNM"] ?? null),
    QQI7: asNumber(row["QQI7"] ?? null),
    // **値の入っている列だけ**を持つ。空欄まで運ぶと 282 列 × 記録数になる
    raw: Object.fromEntries(
      Object.entries(row)
        .map(([k, v]) => [k, rawValue(v)] as const)
        .filter((e): e is readonly [string, string | number] => e[1] !== null)
    )
  };
}

/**
 * 読み出す列を決める。
 *
 * **モニター表は 282 列**あり、そのうち 3 列が CCSID 65535 で読めない（`design.md` F8）。
 * ACS の詳細ダイアログはこの中の 40〜60 項目を出しているので、
 * **手で選んだ 21 列では同じ情報を出せない**。そこでモニター表の元になっている
 * `QSYS/QAQQDBMN` の列一覧をホストから引いて、読める列を全部読む。
 *
 * **列名を焼き込まない**のは版数差があるため——7.5 に無い列を `SELECT` に並べると
 * 採取ごと失敗する。引けなかったときは従来の固定列に落とす（**計画が採れなくなるより良い**）。
 * 接続ごとに 1 回だけ引いて使い回す。
 */
const columnCache = new WeakMap<DbConnection, readonly string[]>();

async function monitorColumns(conn: DbConnection): Promise<readonly string[]> {
  const cached = columnCache.get(conn);
  if (cached) return cached;
  try {
    const res = await queryLimited(
      conn,
      // **`CCSID <> 65535` だけでは数値列が落ちる**（数値列の CCSID は NULL で、
      // `NULL <> 65535` は真にならない）。実際これで文字列の列しか拾えず、
      // 「判断に使う列が欠けている」と見なして固定列へ落ちていた
      "SELECT COLUMN_NAME FROM QSYS2.SYSCOLUMNS " +
        "WHERE TABLE_SCHEMA = 'QSYS' AND TABLE_NAME = 'QAQQDBMN' " +
        "AND (CCSID IS NULL OR CCSID <> 65535) " +
        "ORDER BY ORDINAL_POSITION",
      { limit: 400 }
    );
    const names = res.rows
      .map((r) => (typeof r["COLUMN_NAME"] === "string" ? r["COLUMN_NAME"].trim() : ""))
      .filter((n) => /^[A-Z0-9_]+$/u.test(n));
    // **判断に使う列が欠けていたら使わない**（型付きの欄が空になって静かに壊れる）
    const complete = MONITOR_COLUMNS.every((c) => names.includes(c));
    const out = names.length > 0 && complete ? names : MONITOR_COLUMNS;
    columnCache.set(conn, out);
    return out;
  } catch (e) {
    log.debug(`monitor column discovery failed; falling back to the fixed list: ${String(e)}`);
    columnCache.set(conn, MONITOR_COLUMNS);
    return MONITOR_COLUMNS;
  }
}

/**
 * 読み込む記録の上限。**1 つの文が数千の記録を出すことは無い**（実測で最大 19 件）。
 * ジョブ全体の記録が混ざるので余裕を持たせつつ、青天井にはしない。
 */
const MAX_MONITOR_ROWS = 2000;

/** モニター表を読む。**列を明示する**（CCSID 65535 の 3 列を避ける。research F8） */
export async function readMonitorRecords(conn: DbConnection, table: string): Promise<MonitorRecord[]> {
  const columns = await monitorColumns(conn);
  const sql = `SELECT ${columns.join(", ")} FROM QTEMP.${table}`;
  const result = await queryLimited(conn, sql, { limit: MAX_MONITOR_ROWS });
  return result.rows.map(toRecord);
}

/** 対象の文を実行する。`no-rows` は SELECT 系のみ */
async function runTarget(
  conn: DbConnection,
  sql: string,
  opts: CaptureOptions
): Promise<{ rows?: Row[]; columns?: ColumnMeta[]; truncated?: boolean }> {
  if (opts.mode === "no-rows") {
    if (isNonQueryStatement(sql)) {
      // **黙って run に落とさない。** 行を返さないつもりの操作で更新が走るのが最悪
      throw new As400Error(
        "CONFIG_ERROR",
        "行を返さずに計画だけ取るモードは SELECT 系の文でのみ使えます"
      );
    }
    // **open した時点で最適化が走る**（research F7）。1 行も読まずに閉じる。
    // `close()` は `01-foundation` で足した——以前はここで接続ロックが残った（F9）
    const opened = await openQuery(conn, sql);
    await opened.close();
    return { columns: opened.columns };
  }
  if (isNonQueryStatement(sql)) {
    const done = await executeStatement(conn, sql, {
      resultLimit: opts.limit ?? 200,
      ...(opts.lob ? { lob: opts.lob } : {})
    });
    // **手続きが返した結果セットも渡す。** SELECT の「実行して計画」は行と計画の
    // 両方を返すので、`CALL` だけ計画しか出ないと同じボタンの意味が変わってしまう
    if (done.resultSet) {
      return {
        rows: done.resultSet.rows,
        columns: done.resultSet.columns,
        truncated: done.resultSet.truncated
      };
    }
    return {};
  }
  const result = await queryLimited(conn, sql, {
    limit: opts.limit ?? 200,
    ...(opts.lob ? { lob: opts.lob } : {})
  });
  return { rows: result.rows, columns: result.columns, truncated: result.truncated };
}

/**
 * 自ジョブの DB モニターで実行計画を採る。
 *
 * @throws `As400Error("HOST_SERVER_UNSUPPORTED")` `STRDBMON` が通らないとき（**文は実行していない**）
 * @throws `As400Error("PROTOCOL_ERROR")` 計画記録が 1 件も採れなかったとき
 *         （**空の計画を成功として返さない**）
 * @throws 対象の文自身のエラー（`SqlError` 等）。**後始末は済ませてから投げ直す**
 */
export async function capturePlan(
  conn: DbConnection,
  sql: string,
  opts: CaptureOptions
): Promise<CaptureResult> {
  const table = monitorTableName(Date.now());
  const warnings: string[] = [];

  await endMonitorQuietly(conn);
  try {
    await runCl(conn, `STRDBMON OUTFILE(QTEMP/${table}) JOB(*) TYPE(*DETAIL)`);
  } catch (e) {
    // **文を実行しない。** 計画が採れないのに副作用だけ起こさないため
    throw new As400Error(
      "HOST_SERVER_UNSUPPORTED",
      `この接続では実行計画を採取できません（STRDBMON が通りませんでした: ${String(e)}）`
    );
  }

  try {
    let target: { rows?: Row[]; columns?: ColumnMeta[]; truncated?: boolean };
    const started = Date.now();
    let elapsedMs: number;
    try {
      target = await runTarget(conn, sql, opts);
      elapsedMs = Date.now() - started;
    } finally {
      // **モニターは必ず止める。** 文が失敗しても残さない
      try {
        await runCl(conn, "ENDDBMON JOB(*)");
      } catch (e) {
        warnings.push(`モニターの停止に失敗しました（残っている可能性があります）: ${String(e)}`);
      }
    }

    const all = await readMonitorRecords(conn, table);
    const records = pickStatementRecords(all, sql);
    // 列の論理名。**引けなくても計画は出す**（列名のまま出るだけ）
    const columnLabels = await monitorColumnLabels(conn);
    const plan = buildQueryPlan(records, {
      captured: opts.mode,
      at: opts.at,
      statement: sql,
      columnLabels,
      ...(opts.mode === "run" ? { elapsedMs } : {})
    });

    // **空の計画を成功として返さない**（spec「エラー処理」）。
    //
    // 記録が 1 件も無い場合だけでなく、**ノードが 0 件**の場合もここで弾く——
    // SR-OSAKA で実測したところ、**同じ接続で同じ文を 2 回完全オープンすると、
    // 3 回目以降は最適化記録が出なくなる**（1・2 回目は 12 ノード、3 回目以降は 0 ノード。
    // 文を変えると再び出る）。IBM i がオープン済みデータパス（ODP）を再利用し、
    // 完全オープンを避けるため。**記録そのものは QQ1000 で引けてしまう**ので、
    // 件数だけ見ていると「空の計画」を成功として返してしまう。
    //
    // コードは `NOT_FOUND`——**接続は健全**（後始末は済んでいる）。
    // 呼び出し側は**新しい接続で 1 度だけやり直す**ことで回復できる（`host-plan.ts`）。
    if (plan.summary.nodeCount === 0) {
      throw new As400Error(
        "NOT_FOUND",
        "この文からは計画記録が採れませんでした" +
          "（同じ接続で同じ文を繰り返すと、ホストがオープン済みデータパスを再利用して" +
          "計画を作り直さないことがあります）"
      );
    }

    /**
     * **同じ採取に含まれる他の文の計画。**
     *
     * 手続きの `CALL` は中のカーソルごとに別の組になる。1 組しか返さないと
     * 2 本目以降が見えないので、計画記録を持つ組を実行順で全部渡す。
     *
     * **`plan` は今までどおり**（既存の保存済み JSON・実行履歴を読めなくしない）。
     * 組が 1 つしか無ければ付けない——普通の SELECT の応答を変えないため。
     */
    const groups = pickAllStatements(all);
    const plans =
      groups.length > 1
        ? groups.map((g: MonitorRecord[]) =>
            buildQueryPlan(g, {
              captured: opts.mode,
              at: opts.at,
              columnLabels,
              // **文テキストは組ごとに違う**（中のカーソルの SELECT）。
              // ここで `sql` を渡すと全部 `CALL …` になって選べなくなる
              ...(opts.mode === "run" ? { elapsedMs } : {})
            })
          )
        : undefined;
    // **文の組の番号（`QQUCNT`）で突き合わせる。** 文テキストでは合わない（`plan` は
    // 書いた文、`plans` の要素は中のカーソルの文を名乗る）し、配列の同一性でも合わない
    // ——`pickStatementRecords` と `pickAllStatements` はそれぞれ別に組み直すため
    const primaryKey = records[0]?.QQUCNT;
    const primaryIndex =
      primaryKey === undefined || primaryKey === null
        ? -1
        : groups.findIndex((g: MonitorRecord[]) => g[0]?.QQUCNT === primaryKey);

    const result: CaptureResult = { plan, warnings };
    if (plans) {
      result.plans = plans;
      if (primaryIndex >= 0) result.primaryIndex = primaryIndex;
    }
    if (target.rows) result.rows = target.rows;
    if (target.columns) result.columns = target.columns;
    if (target.truncated !== undefined) result.truncated = target.truncated;
    return result;
  } finally {
    // **どの経路を通っても表を落とす**
    await dropQuietly(conn, table);
  }
}
