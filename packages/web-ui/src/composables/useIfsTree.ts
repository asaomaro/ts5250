/**
 * IFS のツリーの状態。
 *
 * **サーバーの「素直に読むと間違える」形をここで吸収する。**
 * コンポーネントに素の応答を渡すと、同じ罠を画面側でも踏むことになる:
 *
 * - `entries` が空でも `hasMore` が true になりうる（`.` と `..` が件数上限を消費する）。
 *   「空 = 終わり」と解釈すると、中身のあるディレクトリが空に見える
 * - `canContinue` を見ずに `nextRestartId` を渡し続けると無限ループする
 *   （`/QSYS.LIB` は全エントリの Restart ID が 0 で返る）
 */
import { ref } from "vue";
import { listFiles, IfsRequestError, type IfsEntry, type IfsSource } from "../ifsApi.js";

/** 1 回の要求で取る件数。巨大ディレクトリ対策（`/QSYS.LIB` は直下 21,192 件） */
const PAGE_SIZE = 1000;
/**
 * 1 ノードで取り続ける上限。
 * サーバーが際限なく「続きがある」と言い続けた場合の歯止め。
 */
const MAX_PAGES = 20;

export type NodeState = "unloaded" | "loading" | "partial" | "loaded" | "error";

export interface TreeNode {
  path: string;
  entries: IfsEntry[];
  state: NodeState;
  /** 続きを取るための起点。`state === "partial"` のときだけ意味を持つ */
  nextRestartId?: number | undefined;
  /**
   * 続きはあるが**辿る手段が無い**（`/QSYS.LIB` など）。
   * `state === "partial"` と併せて「先頭 N 件まで」と伝えるために使う。
   */
  blocked?: boolean | undefined;
  error?: string | undefined;
}

export function useIfsTree(source: () => IfsSource) {
  /**
   * パス → ノード。**入れ子オブジェクトの木にしない**——
   * 任意のノードを親から辿らずに更新でき、展開状態の再計算も要らない。
   */
  const nodes = ref(new Map<string, TreeNode>());
  /** 展開されているパス */
  const expanded = ref(new Set<string>());

  function nodeAt(path: string): TreeNode {
    const found = nodes.value.get(path);
    if (found) return found;
    const created: TreeNode = { path, entries: [], state: "unloaded" };
    nodes.value.set(path, created);
    return created;
  }

  function update(path: string, patch: Partial<TreeNode>): void {
    const next = { ...nodeAt(path), ...patch };
    // Map の差し替えで Vue に変更を伝える
    const copy = new Map(nodes.value);
    copy.set(path, next);
    nodes.value = copy;
  }

  /**
   * 1 ページ取って積む。
   *
   * `restartId` を渡さなければ最初から、渡せば続きから。
   * **空のページでも続きがあれば `partial` のままにする**——ここで `loaded` にすると、
   * `.` と `..` だけで枠を使い切ったディレクトリが空に見える。
   */
  async function loadPage(path: string, restartId?: number): Promise<void> {
    update(path, { state: "loading" });
    try {
      const page = await listFiles(source(), path, {
        maxCount: PAGE_SIZE,
        ...(restartId !== undefined ? { restartId } : {})
      });
      const before = restartId === undefined ? [] : nodeAt(path).entries;
      const entries = [...before, ...page.entries];

      if (!page.hasMore) {
        // 成功したら前の失敗を消す。残すと、後から `error` を読む実装を足した瞬間に古い文言が出る
        update(path, { state: "loaded", entries, blocked: false, error: undefined });
        return;
      }
      if (!page.canContinue || page.nextRestartId === undefined) {
        // まだあるが辿れない。**空でも「終わった」ことにしない**
        update(path, { state: "partial", entries, blocked: true, error: undefined });
        return;
      }
      update(path, {
        state: "partial",
        entries,
        blocked: false,
        error: undefined,
        nextRestartId: page.nextRestartId
      });
    } catch (e) {
      const message =
        e instanceof IfsRequestError ? e.message : e instanceof Error ? e.message : String(e);
      update(path, { state: "error", error: message });
    }
  }

  /** ディレクトリを読む（未取得なら取得する） */
  async function load(path: string): Promise<void> {
    const node = nodeAt(path);
    if (node.state === "loading") return;
    if (node.state === "loaded") return;
    update(path, { entries: [] });
    await loadPage(path);
  }

  /**
   * 続きを取る。**`blocked` なら何もしない**——
   * 辿れない場所で起点を渡し続けると、同じページが永久に返る。
   */
  async function loadMore(path: string): Promise<void> {
    const node = nodeAt(path);
    if (node.state !== "partial" || node.blocked) return;
    if (node.nextRestartId === undefined) return;
    await loadPage(path, node.nextRestartId);
  }

  /** 続きが無くなるまで辿る（zip の前など、全件が要る場面用） */
  async function loadAll(path: string): Promise<void> {
    await load(path);
    for (let i = 0; i < MAX_PAGES; i++) {
      const node = nodeAt(path);
      if (node.state !== "partial" || node.blocked) return;
      await loadMore(path);
    }
  }

  async function toggle(path: string): Promise<void> {
    const next = new Set(expanded.value);
    if (next.has(path)) {
      next.delete(path);
      expanded.value = next;
      return;
    }
    next.add(path);
    expanded.value = next;
    await load(path);
  }

  /** 中身が変わった可能性のあるディレクトリを取り直す */
  async function refresh(path: string): Promise<void> {
    update(path, { state: "unloaded", entries: [], error: undefined, blocked: false });
    await load(path);
  }

  /** すべて捨てる。システムを切り替えたときに使う（別システムの一覧を見せない） */
  function reset(): void {
    nodes.value = new Map();
    expanded.value = new Set();
  }

  return { nodes, expanded, nodeAt, load, loadMore, loadAll, toggle, refresh, reset };
}
