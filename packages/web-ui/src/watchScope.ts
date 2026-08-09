/**
 * **監視コンソールをシステムごとに分ける**（`20260802-tabs-own-system`）。
 *
 * 監視コンソールだけは長らくシステムに紐づかない 1 枚で、タブにシステムカラーの帯が
 * 付かなかった（利用者の指摘）。帯は「このタブはどのシステムを相手にしているか」を
 * 表すものなので、**帯を付けるなら中身も 1 システムぶんでなければ嘘になる**。
 * そこでタブ ID にシステムを載せ（`watch:queues@own:a`）、一覧・未読をここで絞る。
 *
 * **絞り方を 1 か所に置く。** 一覧（`WatchPane`）とタブのバッジ（`PaneTabs`）が
 * 別々に絞ると、片方だけ直し忘れたときに「バッジは出るのに開いても何も無い」になる。
 */
import type { WatchView } from "@ts5250/server";
import { splitPaneTabId } from "./paneLabels.js";
import { systemsStore } from "./stores/systems.js";
import { watchesStore } from "./stores/watches.js";

/**
 * その監視が属するシステム。**由来のセッション設定から引く**——監視自身は
 * システムを持たず、`ref`（`srv:` / `own:`）だけを持っている。
 *
 * 設定が引けないことがある（他人の個人設定で始まった監視を管理者が見ている等）。
 */
export function systemOfWatch(ref: string): string | undefined {
  return systemsStore.sessions.find((s) => s.ref === ref)?.system;
}

/**
 * そのタブが受け持つシステム。**タブ ID から引く**（`workspaceStore.systemOf` と同じ源）。
 * `undefined` は「システムに紐づかない古いタブ」＝全部を出す。
 */
export function watchScopeOf(tabId: string): string | undefined {
  return splitPaneTabId(tabId).system;
}

/**
 * そのタブに出す監視。
 *
 * **システムを引けない監視はどのタブにも出す。** 落とすと、消費し続けているものが
 * 画面から消えてしまう——重複して見えるほうがはるかに軽い害である。
 */
export function watchesForTab(tabId: string): WatchView[] {
  const sys = watchScopeOf(tabId);
  if (sys === undefined) return watchesStore.watches;
  return watchesStore.watches.filter((w) => {
    const owner = systemOfWatch(w.ref);
    return owner === undefined || owner === sys;
  });
}

/** そのタブの未読合計（タブのバッジ）。一覧に出るものだけを数える */
export function unreadForTab(tabId: string): number {
  let n = 0;
  for (const w of watchesForTab(tabId)) n += watchesStore.unreadOf(w.id);
  return n;
}
