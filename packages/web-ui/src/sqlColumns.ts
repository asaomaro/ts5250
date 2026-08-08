/**
 * 補完の候補（列・表）をホストから引く。
 *
 * **専用の入口を作らず既存の `/api/host/sql` へ投げる**（`planApi.ts` の索引作成と同じ理由）。
 * SQL 欄に同じ文を打てば通るので**新しい権限を増やさず**、監査もそのまま乗る。
 *
 * 打鍵のたびにホストへ行かないよう、**接続先＋対象ごとに 1 度だけ引いて覚える**。
 * 表の列もライブラリーの表も SQL を書いている最中に変わらないので、寿命はタブと同じでよい。
 */
import type { TableRef } from "./sqlRefs.js";

export interface Candidate {
  name: string;
  /** 種別（列ならデータ型、表なら `表` / `ビュー` / `別名`）。候補の脇に出す */
  type?: string;
  /** 説明（`COLUMN_TEXT` / `TABLE_TEXT`。あれば出す） */
  text?: string;
}

/** いま出している候補の種類。読み上げの見出しに使う */
export type CandidateKind = "column" | "table";

/** 引けなかったことも覚える（同じ対象に毎回問い合わせない） */
type Entry = { items: Candidate[] };

const cache = new Map<string, Promise<Entry>>();

/** SQL の文字列リテラルに埋める。**`'` は 2 つに増やす** */
function quote(s: string): string {
  return `'${s.replace(/'/gu, "''")}'`;
}

/**
 * 1 度だけ引いて覚える。
 *
 * ⚠ **失敗しても投げない。** 候補が出ないだけで、SQL を書く手は止めない。
 */
function once(key: string, run: () => Promise<Candidate[]>): Promise<Candidate[]> {
  const hit = cache.get(key);
  if (hit) return hit.then((e) => e.items);
  const task = (async (): Promise<Entry> => {
    try {
      return { items: await run() };
    } catch {
      return { items: [] };
    }
  })();
  cache.set(key, task);
  return task.then((e) => e.items);
}

/** `/api/host/sql` に投げて行を取る。失敗は空配列（例外にしない） */
async function rowsOf(source: string, sql: string): Promise<Record<string, unknown>[]> {
  const res = await fetch("/api/host/sql", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: { system: source }, sql, pageSize: 500 })
  });
  if (!res.ok) return [];
  const data: { rows?: Record<string, unknown>[] } = await res.json();
  return data.rows ?? [];
}

const str = (row: Record<string, unknown>, key: string): string =>
  typeof row[key] === "string" ? row[key].trim() : "";

/**
 * 表の列を引く（`別名.` / `表名.` の候補）。
 *
 * ライブラリーが書かれていなければ**絞り込まない**——ライブラリー・リストの解決までは
 * こちらでは追えないので、同じ表名が複数のライブラリーにあれば全部返す
 * （重複する列名は 1 つに畳む）。
 */
export async function fetchColumns(source: string, ref: TableRef): Promise<Candidate[]> {
  const where = [`TABLE_NAME = ${quote(ref.name)}`];
  if (ref.schema) where.push(`TABLE_SCHEMA = ${quote(ref.schema)}`);
  const sql =
    "SELECT COLUMN_NAME, DATA_TYPE, COLUMN_TEXT FROM QSYS2.SYSCOLUMNS " +
    `WHERE ${where.join(" AND ")} ORDER BY ORDINAL_POSITION`;

  return once(`col ${source} ${ref.schema ?? ""} ${ref.name}`, async () => {
    const seen = new Set<string>();
    const out: Candidate[] = [];
    for (const row of await rowsOf(source, sql)) {
      const name = str(row, "COLUMN_NAME");
      if (name === "" || seen.has(name)) continue;
      seen.add(name);
      const type = str(row, "DATA_TYPE");
      const text = str(row, "COLUMN_TEXT");
      out.push({ name, ...(type ? { type } : {}), ...(text ? { text } : {}) });
    }
    return out;
  });
}

/**
 * `TABLE_TYPE` の表示名。
 *
 * **実測で確かめたものだけ**に名前を付ける（実機 7.3）——`A` は `BASE_TABLE_NAME` を
 * 持つ（別名）、`V` は `SYSVIEWS` に載る（ビュー）、`T` は表。
 * 確かめていないコード（`P` など）は**コードのまま出す**。
 */
function tableTypeLabel(code: string): string {
  if (code === "T") return "表";
  if (code === "V") return "ビュー";
  if (code === "A") return "別名";
  return code;
}

/**
 * ライブラリー（スキーマ）の表を引く（`ライブラリー.` の候補）。
 *
 * 表・ビュー・別名をまとめて出す——SQL からはどれも `FROM` に書けるので、
 * 書く側にとっては同じ「表の候補」。種別は脇に出して見分けられるようにする。
 */
export async function fetchTables(source: string, schema: string): Promise<Candidate[]> {
  const name = schema.toUpperCase();
  const sql =
    "SELECT TABLE_NAME, TABLE_TYPE, TABLE_TEXT FROM QSYS2.SYSTABLES " +
    `WHERE TABLE_SCHEMA = ${quote(name)} ORDER BY TABLE_NAME`;

  return once(`tbl ${source} ${name}`, async () => {
    const out: Candidate[] = [];
    for (const row of await rowsOf(source, sql)) {
      const table = str(row, "TABLE_NAME");
      if (table === "") continue;
      const type = tableTypeLabel(str(row, "TABLE_TYPE"));
      const text = str(row, "TABLE_TEXT");
      out.push({ name: table, ...(type ? { type } : {}), ...(text ? { text } : {}) });
    }
    return out;
  });
}

/** テスト用。**接続や表を切り替えたときに前の結果を引きずらない**ようにするため */
export function clearColumnCache(): void {
  cache.clear();
}
