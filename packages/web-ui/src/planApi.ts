/**
 * 実行計画 API の呼び出しと、画面側で使う型。
 *
 * **型はサーバー（`@ts5250/hostserver` の `plan-model.ts`）から `import type` する。**
 * 手で写すと、サーバー側で形が変わったときに**黙ってずれる**（AGENTS.md が繰り返し戒めている
 * 「同じ定義が 2 か所」）。`@ts5250/hostserver` は web-ui の **devDependency** だが、
 * `import type` は実行時コードを出さないのでバンドルにも本番インストールにも入らない
 * （AGENTS.md「パッケージ分割と入口」。`SpoolPane.vue` が `@ts5250/server` の型で同じ手を使っている）。
 */
export type {
  QueryPlan,
  PlanBlock,
  PlanNode,
  PlanNodeKind,
  PlanAttribute,
  PlanSummary,
  PlanCapture,
  IndexAdvice
} from "@ts5250/hostserver";
import type { QueryPlan } from "@ts5250/hostserver";

export interface ExplainResponse {
  plan: QueryPlan;
  rows?: Record<string, unknown>[];
  columns?: { name: string; typeName: string }[];
  truncated?: boolean;
  warnings?: string[];
}

export interface PlanListItem {
  id: string;
  statement: string;
  tables: string[];
  recordCount: number;
}

export interface PlanListResponse {
  available: boolean;
  reason?: string;
  items: PlanListItem[];
}

/** 採取モード。**`no-rows` は「実行しない」ではない**（行を返さないだけ） */
export type CaptureMode = "run" | "no-rows";

async function jsonOrThrow<T>(res: Response): Promise<T> {
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

/**
 * 計画を採る。
 *
 * **`source` はシステム参照の文字列で受け、`{ system }` に包んで送る。**
 * サーバーの `sourceSchema` はオブジェクト（`{ system?, session? }`）で、
 * 文字列のまま送ると `Invalid input: expected object, received string` で 400 になる
 * ——実ブラウザ検証で踏んだ（単体テストは `fetch` を偽装していたので形が検証されていなかった）。
 */
export async function explainSql(args: {
  source: string;
  sql: string;
  mode: CaptureMode;
  maxRows?: number;
}): Promise<ExplainResponse> {
  const res = await fetch("/api/host/sql/explain", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      source: { system: args.source },
      sql: args.sql,
      mode: args.mode,
      ...(args.maxRows !== undefined ? { maxRows: args.maxRows } : {})
    })
  });
  return jsonOrThrow<ExplainResponse>(res);
}

/**
 * 助言の索引を作る。**専用の入口を作らず既存の SQL 経路へ送る**——
 * SQL 欄に同じ文を打てば通るので新しい権限を増やさず、監査もそのまま乗る。
 */
export async function runSql(args: { source: string; sql: string }): Promise<void> {
  const res = await fetch("/api/host/sql", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: { system: args.source }, sql: args.sql })
  });
  await jsonOrThrow<unknown>(res);
}

/**
 * プランキャッシュ一覧。**権限が無いときも例外にならない**——
 * `available:false` と `reason` が返る（画面は理由を出して履歴側へ切り替える）。
 */
export async function fetchPlanList(args: { source: string; topN?: number }): Promise<PlanListResponse> {
  // **クエリは文字列しか運べない**ので、接続先は `system` として渡す（`host-plan.ts` の注記）
  const q = new URLSearchParams({ system: args.source });
  if (args.topN !== undefined) q.set("topN", String(args.topN));
  const res = await fetch(`/api/host/plans?${q.toString()}`);
  return jsonOrThrow<PlanListResponse>(res);
}

export async function fetchPlan(args: { source: string; id: string; topN?: number }): Promise<QueryPlan> {
  const q = new URLSearchParams({ system: args.source });
  if (args.topN !== undefined) q.set("topN", String(args.topN));
  const res = await fetch(`/api/host/plans/${encodeURIComponent(args.id)}?${q.toString()}`);
  return (await jsonOrThrow<{ plan: QueryPlan }>(res)).plan;
}
