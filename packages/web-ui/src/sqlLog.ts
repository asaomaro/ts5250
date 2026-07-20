/**
 * SQL 実行ログの記録。
 *
 * **画面の中だけに置く。** サーバーへは送らない——監査ログ（`server/src/audit.ts`）は
 * 「フィールド値を記録しない」方針で、SQL 文には `WHERE PASSWORD='…'` のような値が
 * 入りうる。方針を曲げずに利用者が自分の実行履歴を見られるようにするため、
 * ここはタブの中の記録に留める（タブを閉じれば消える）。
 *
 * 5250 の操作ログ（`stores/log.ts`）とは別に持つ。あちらの `dir` は
 * `"tx" | "rx" | "event"` 固定で、SQL の実行（文・件数・所要時間・SQLCODE）に合わない。
 */

/** 実行 = 「実行」ボタン、読み足し = End/PageDown/スクロール */
export type SqlLogKind = "run" | "more";

export interface SqlLogEntry {
  id: number;
  /** 壁時計。利用者は「いつ実行したか」で突き合わせる（性能計測用の精度は要らない） */
  ts: number;
  kind: SqlLogKind;
  sql: string;
  status: "ok" | "error";
  ms: number;
  rowCount?: number;
  hasMore?: boolean;
  /** SQLCODE / SQLSTATE やエラー本文 */
  detail?: string;
}

/** 溜め込みすぎない。1 タブぶんの履歴として十分な数 */
export const SQL_LOG_MAX = 200;

let seq = 0;

/**
 * 追記して、古いものを落とした配列を返す。
 * 呼び出し側の ref をそのまま差し替えられるように**新しい配列を返す**。
 */
export function appendSqlLog(entries: SqlLogEntry[], e: Omit<SqlLogEntry, "id">): SqlLogEntry[] {
  const next = [...entries, { ...e, id: ++seq }];
  return next.length > SQL_LOG_MAX ? next.slice(next.length - SQL_LOG_MAX) : next;
}
