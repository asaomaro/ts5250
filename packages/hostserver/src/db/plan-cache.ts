/**
 * プランキャッシュからの計画一覧——**システム全体の計画を見る（要特権）**。
 *
 * ## 自ジョブ採取（`plan-capture.ts`）との違い
 *
 * | | 自ジョブ採取 | プランキャッシュ |
 * |---|---|---|
 * | 見えるもの | **自分が今流した文** | **システム上の文**（他の利用者のものも） |
 * | 特権 | **不要**（research F14。PUB400 の非特権ユーザーで実測） | **要**（research F15） |
 *
 * ## 特権が無いときは黙らない
 *
 * PUB400（特殊権限なしの `USER`）で `CALL QSYS2.DUMP_PLAN_CACHE_TOPN(...)` は
 * **`SQLCODE -443 / SQLSTATE 38501`** で失敗した（research F15 の実測）。
 * `38501` は「外部ルーチンの呼び出しが認可されなかった」。
 * → **この組み合わせだけを「権限不足」と判定する。** 他の SQLCODE を権限と決めつけると、
 * 利用者が無駄に権限を探しに行く。
 *
 * ## 2 段目の `DUMP_PLAN_CACHE` を呼ばない
 *
 * `DUMP_PLAN_CACHE_TOPN` が作る表は**一覧と計画詳細の両方**を含む（research F16。
 * TOPN=5 で `QQUCNT` の異なり 6 文、`3000`/`3003`/`3006`/`3019` 等の詳細記録つき）。
 * よって行を選んだら**同じ表を `QQUCNT` で絞る**だけでよい。
 *
 * これには 2 つの利点がある:
 *
 * - `PLAN_IDENTIFIER` の在りかが分かっていない問題（research F16。候補列 8 つを対照実験つきで
 *   潰したが特定できず、あり得ない id でも「`QQRID 3018` が 2 行」返るだけだった）を回避できる。
 * - **`DUMP_PLAN_CACHE` の引数が 7.3 で 3 個・7.5 で 7 個**という版数差（research F13）を踏まない。
 */
import { As400Error } from "@ts5250/base";
import { childLog } from "@ts5250/base";
import type { DbConnection } from "./db-connection.js";
import { executeStatement } from "./execute.js";
import { SqlError } from "./query.js";
import { readMonitorRecords, monitorTableName } from "./plan-capture.js";
import { monitorColumnLabels } from "./plan-column-text.js";
import { buildQueryPlan, groupByStatement, type MonitorRecord, type QueryPlan } from "./plan-model.js";

const log = childLog({ component: "hostserver-plan-cache" });

/** 実測で有効だった並び（research F1）。他の値は確かめていないので使わない */
const CATEGORY = "RUNTIME";

/** 権限不足の印。**この組み合わせだけ**を権限と判定する（research F15） */
const AUTH_SQLCODE = -443;
const AUTH_SQLSTATE = "38501";

export interface PlanListItem {
  /** この一覧の中での識別子（`QQUCNT`） */
  id: string;
  statement: string;
  /** 走査した表（重複なし） */
  tables: string[];
  /** 記録の件数（計画の大きさの目安） */
  recordCount: number;
}

export interface PlanListResult {
  /** 参照できたか。`false` なら `reason` に理由が入る */
  available: boolean;
  /** 参照できない理由（利用者に見せる日本語） */
  reason?: string;
  items: PlanListItem[];
}

function isAuthorizationFailure(e: unknown): boolean {
  return e instanceof SqlError && e.sqlCode === AUTH_SQLCODE && e.sqlState === AUTH_SQLSTATE;
}

/** 権限不足のときに見せる文言。**何が要るかまで書く**（「できません」で終わらせない） */
const AUTH_REASON =
  "この接続では計画一覧を参照できません（システム全体の計画を見るには *JOBCTL 等の特権が要ります）";

async function dropQuietly(conn: DbConnection, table: string): Promise<void> {
  try {
    await executeStatement(conn, `DROP TABLE QTEMP.${table}`);
  } catch (e) {
    log.debug(`DROP TABLE QTEMP.${table} ignored: ${String(e)}`);
  }
}

/**
 * プランキャッシュの上位 N をダンプして記録を読む。
 *
 * 呼び出しごとにダンプし直す（状態を持たない）。**キャッシュは変わりうる**ので、
 * 一覧で見えた文が次の呼び出しで消えていることがある——呼び出し側はそれを扱うこと。
 */
async function dumpTopN(conn: DbConnection, topN: number): Promise<MonitorRecord[]> {
  const table = monitorTableName(Date.now());
  await executeStatement(
    conn,
    `CALL QSYS2.DUMP_PLAN_CACHE_TOPN('QTEMP', '${table}', ${Math.trunc(topN)}, '${CATEGORY}')`
  );
  try {
    return await readMonitorRecords(conn, table);
  } finally {
    await dropQuietly(conn, table);
  }
}

/** 一覧に出す 1 件分に畳む */
function toItem(id: number, records: MonitorRecord[]): PlanListItem {
  const statement = records
    .map((r) => r.QQ1000?.trim() ?? "")
    .reduce((longest, s) => (s.length > longest.length ? s : longest), "");
  const tables = [
    ...new Set(
      records
        .map((r) => r.QVQTBL?.trim())
        .filter((t): t is string => t !== undefined && t !== "")
    )
  ];
  return { id: String(id), statement, tables, recordCount: records.length };
}

/**
 * プランキャッシュ上位 N の一覧。
 *
 * **権限が無ければ例外にせず `available:false` と理由を返す**——
 * 一覧が使えないことは「異常」ではなく「この接続の性質」で、画面は実行履歴側へ切り替えられる。
 */
export async function listPlansFromCache(conn: DbConnection, topN: number): Promise<PlanListResult> {
  let records: MonitorRecord[];
  try {
    records = await dumpTopN(conn, topN);
  } catch (e) {
    if (isAuthorizationFailure(e)) return { available: false, reason: AUTH_REASON, items: [] };
    // **権限と決めつけない。** 原因をそのまま見せる
    const reason = e instanceof SqlError ? `計画一覧を取得できません（SQLCODE=${e.sqlCode} SQLSTATE=${e.sqlState}）` : `計画一覧を取得できません（${String(e)}）`;
    return { available: false, reason, items: [] };
  }
  const items = [...groupByStatement(records).entries()]
    .map(([id, list]) => toItem(id, list))
    // 文テキストが取れないものは一覧に出しても選べない
    .filter((i) => i.statement !== "");
  return { available: true, items };
}

/**
 * 一覧の 1 件を計画に畳む。**同じダンプ表を `QQUCNT` で絞るだけ**（2 段目の `CALL` はしない）。
 *
 * @throws `As400Error("NOT_FOUND")` 指定の id がダンプに無いとき。
 *         **プランキャッシュは変わりうる**ので、消えたことを黙らずに伝える
 */
export async function planFromCache(
  conn: DbConnection,
  topN: number,
  id: string,
  at: string
): Promise<QueryPlan> {
  const records = await dumpTopN(conn, topN);
  const group = groupByStatement(records).get(Number(id));
  if (!group || group.length === 0) {
    throw new As400Error(
      "NOT_FOUND",
      "その計画は見つかりませんでした（プランキャッシュの内容が変わった可能性があります）"
    );
  }
  // 採取と同じく列の論理名を添える（一覧から開いた計画でも見え方を揃える）
  const columnLabels = await monitorColumnLabels(conn);
  return buildQueryPlan(group, { captured: "plan-cache", at, columnLabels });
}
