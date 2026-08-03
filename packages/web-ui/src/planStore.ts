/**
 * 実行計画の履歴・保存・比較。
 *
 * ## なぜブラウザに持つのか
 *
 * サーバー側に保存領域を新設すると、**認可・容量・寿命の管理が丸ごと増える**。
 * 計画は診断用の一時物で、共有が要るときは JSON で持ち出せば足りる。
 * （`spec.md`「保存・比較」でこの方針を選んだ。）
 *
 * ## 秘密の扱い
 *
 * 計画には**文テキストが含まれる**（リテラルに秘密が埋まっている可能性がある）。
 * 保存は**利用者の明示操作でのみ**行い、履歴はセッション中のメモリではなく
 * localStorage に置くが、**上限を設けて溜め込ませない**。
 */
import { reactive } from "vue";
import type { PlanNode, QueryPlan } from "./planApi.js";

/** 保存の上限。超えたら古い順に落とす（**落としたことは呼び出し側に返す**） */
export const MAX_SAVED = 20;
/** 履歴の上限（このアプリで採った計画） */
export const MAX_HISTORY = 20;

const SAVED_KEY = "ts5250.plans.saved";
const HISTORY_KEY = "ts5250.plans.history";

export interface StoredPlan {
  /** 保存時に振る id（localStorage 内で一意） */
  id: string;
  /** 利用者が付けた名前。既定は文の先頭 */
  name: string;
  plan: QueryPlan;
}

/** JSON 入出力の形。**版を付ける**——形を変えたときに黙って壊れないように */
export interface PlanExport {
  kind: "ts5250.plan";
  version: 1;
  plans: StoredPlan[];
}

interface PlanStoreState {
  saved: StoredPlan[];
  history: StoredPlan[];
}

function read(key: string): StoredPlan[] {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as StoredPlan[]) : [];
  } catch {
    // **壊れた保存で画面を止めない。** 読めないものは無かったことにする
    return [];
  }
}

/**
 * 書けたかを返す。**握り潰さない**——計画は属性まで持つと 1 件で数十 KB になり、
 * 上限 20 件 × 2 種で localStorage の容量に届きうる。
 * 書けなかったのに「保存しました」と出すと、次に開いたとき黙って消えている。
 * （画面の操作自体は続けられるので、例外にはしない。）
 */
function write(key: string, value: StoredPlan[]): boolean {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export const planStore = reactive<PlanStoreState>({
  saved: read(SAVED_KEY),
  history: read(HISTORY_KEY)
});

/** 既定の名前は文の先頭 60 文字（空白を潰す） */
export function defaultName(plan: QueryPlan): string {
  const s = plan.statement.replace(/\s+/gu, " ").trim();
  return s.length > 60 ? `${s.slice(0, 60)}…` : s || "(名前なし)";
}

let seq = 0;
function newId(at: string): string {
  seq += 1;
  return `p-${seq}-${at}`;
}

/**
 * 採った計画を履歴に積む。**上限を超えた分は古い順に落とす**。
 * 落とした件数を返す（黙って消さないため、呼び出し側が知らせられる）。
 */
export function pushHistory(plan: QueryPlan): { dropped: number; persisted: boolean } {
  const entry: StoredPlan = { id: newId(plan.at), name: defaultName(plan), plan };
  planStore.history.unshift(entry);
  const dropped = Math.max(0, planStore.history.length - MAX_HISTORY);
  if (dropped > 0) planStore.history.splice(MAX_HISTORY, dropped);
  const persisted = write(HISTORY_KEY, planStore.history);
  return { dropped, persisted };
}

/** 明示的に保存する。上限超過は古い順に落とし、落とした件数を返す */
export function savePlan(
  plan: QueryPlan,
  name?: string
): { dropped: number; entry: StoredPlan; persisted: boolean } {
  const entry: StoredPlan = { id: newId(plan.at), name: name?.trim() || defaultName(plan), plan };
  planStore.saved.unshift(entry);
  const dropped = Math.max(0, planStore.saved.length - MAX_SAVED);
  if (dropped > 0) planStore.saved.splice(MAX_SAVED, dropped);
  const persisted = write(SAVED_KEY, planStore.saved);
  return { dropped, entry, persisted };
}

export function removeSaved(id: string): void {
  const at = planStore.saved.findIndex((p) => p.id === id);
  if (at >= 0) planStore.saved.splice(at, 1);
  write(SAVED_KEY, planStore.saved);
}

export function clearHistory(): void {
  planStore.history.splice(0, planStore.history.length);
  write(HISTORY_KEY, planStore.history);
}

/** 保存分を JSON にする（共有・退避用） */
export function exportPlans(plans: StoredPlan[]): string {
  const payload: PlanExport = { kind: "ts5250.plan", version: 1, plans };
  return JSON.stringify(payload, null, 2);
}

/**
 * JSON を読み込む。**形が違うものは受け付けない**——
 * 黙って空を足すと「読み込んだのに何も出ない」になり、原因が分からない。
 *
 * @throws `Error` 形が違うとき（利用者に見せる日本語）
 */
export function importPlans(text: string): StoredPlan[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("JSON として読めません");
  }
  const p = parsed as Partial<PlanExport>;
  if (p?.kind !== "ts5250.plan") throw new Error("この JSON は実行計画の書き出しではありません");
  if (p.version !== 1) throw new Error(`対応していない版です（version=${String(p.version)}）`);
  if (!Array.isArray(p.plans)) throw new Error("plans がありません");
  const added: StoredPlan[] = [];
  for (const entry of p.plans) {
    if (!entry?.plan?.blocks || !Array.isArray(entry.plan.blocks)) continue;
    const stored: StoredPlan = { id: newId(entry.plan.at ?? ""), name: entry.name || defaultName(entry.plan), plan: entry.plan };
    planStore.saved.unshift(stored);
    added.push(stored);
  }
  if (added.length === 0) throw new Error("読み込める計画がありませんでした");
  const dropped = Math.max(0, planStore.saved.length - MAX_SAVED);
  if (dropped > 0) planStore.saved.splice(MAX_SAVED, dropped);
  write(SAVED_KEY, planStore.saved);
  return added;
}

// ---- 比較 ----

export interface SummaryDiff {
  label: string;
  left: string;
  right: string;
  changed: boolean;
}

export type NodeDiffState = "same" | "changed" | "left-only" | "right-only";

export interface NodeDiff {
  key: string;
  label: string;
  left?: PlanNode;
  right?: PlanNode;
  state: NodeDiffState;
}

export interface PlanDiff {
  summary: SummaryDiff[];
  nodes: NodeDiff[];
}

/**
 * ノードの対応付けの鍵。**(種別, 対象表, 索引)** で突き合わせる。
 *
 * id（`1-0` 等）は**並び順に依存する**ので使えない——チューニングでノードが 1 つ増えると
 * それ以降が全部「変わった」になり、差分が読めなくなる。
 */
function nodeKey(n: PlanNode): string {
  return [n.kind, n.recordType, n.table ? `${n.table.schema}.${n.table.name}` : "", n.index?.name ?? ""].join("|");
}

function nodeValue(n: PlanNode): string {
  return [n.totalRows ?? "-", n.estimatedRows ?? "-", n.estimatedMs ?? "-", n.reasonCode ?? "-"].join(" / ");
}

function allNodes(plan: QueryPlan): PlanNode[] {
  return plan.blocks.flatMap((b) => b.nodes);
}

function num(v: number | undefined): string {
  return v === undefined ? "-" : String(v);
}

/** 2 つの計画を突き合わせる */
export function diffPlans(left: QueryPlan, right: QueryPlan): PlanDiff {
  const summary: SummaryDiff[] = [
    ["ノード数", String(left.summary.nodeCount), String(right.summary.nodeCount)],
    ["クエリブロック", String(left.summary.blockCount), String(right.summary.blockCount)],
    ["表", left.summary.tables.join(", ") || "-", right.summary.tables.join(", ") || "-"],
    ["索引", left.summary.indexes.join(", ") || "-", right.summary.indexes.join(", ") || "-"],
    ["索引の助言", String(left.summary.adviceCount), String(right.summary.adviceCount)],
    ["推定最大(ms)", num(left.summary.maxEstimatedMs), num(right.summary.maxEstimatedMs)],
    ["実測(ms)", num(left.summary.elapsedMs), num(right.summary.elapsedMs)]
  ].map(([label, l, r]) => ({ label: label!, left: l!, right: r!, changed: l !== r }));

  const leftMap = new Map(allNodes(left).map((n) => [nodeKey(n), n]));
  const rightMap = new Map(allNodes(right).map((n) => [nodeKey(n), n]));
  const keys = [...new Set([...leftMap.keys(), ...rightMap.keys()])];
  const nodes: NodeDiff[] = keys.map((key) => {
    const l = leftMap.get(key);
    const r = rightMap.get(key);
    const state: NodeDiffState = !l ? "right-only" : !r ? "left-only" : nodeValue(l) === nodeValue(r) ? "same" : "changed";
    const diff: NodeDiff = { key, label: (l ?? r)!.label, state };
    if (l) diff.left = l;
    if (r) diff.right = r;
    return diff;
  });
  return { summary, nodes };
}
