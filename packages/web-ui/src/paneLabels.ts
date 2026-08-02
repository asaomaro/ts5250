/**
 * セッションを持たないタブ（管理・一覧・SQL）の定義。
 *
 * タブ帯・パンくず・ヘッダーのトグル出し分けが同じ判定を使うため、1 か所に置く。
 * **プレフィックスの一覧をここに集約している**——以前 `list:*` を `PaneTabs` の判定に
 * 足し忘れ、タブを閉じたときに「セッションの切断」処理へ流れる不具合が出た。
 * 種類が増えるたび各所の `startsWith` を直して回る形だと同じことが再発する。
 */

/** セッションを持たないタブの ID 接頭辞。**新しい種類を足すときはここに追加する** */
export const PANE_PREFIXES = ["admin:", "dtaq:", "ifs:", "list:", "sql:", "transfer:", "spool:", "svc:", "watch:"] as const;

/** セッションを持たない（＝接続の概念が無い）タブか */
export function isPaneTab(id: string | undefined): boolean {
  return Boolean(id) && PANE_PREFIXES.some((p) => id!.startsWith(p));
}

/**
 * **タブ ID にシステムを含める**（`20260802-tabs-own-system`）。
 *
 * ```
 * sql:query@own:a
 * ^^^^^^^^^ 機能   ^^^^^ システム ref
 * ```
 *
 * こうするのは、**A の SQL と B の SQL を同時に開けるようにする**ため。
 * 以前は機能 ID がそのままタブ ID で、ワークスペースに SQL タブは 1 枚しか置けなかった。
 *
 * **区切りが `@` なのは `:` が使えないから。** 機能 ID（`sql:query`）にもシステム ref
 * （`own:a` / `srv:s1`）にも `:` が入っている。`@` はどちらにも現れない。
 *
 * 接頭辞の判定（`isPaneTab` / `PANE_PREFIXES`）は**先頭一致のまま効く**——`@` は後ろに付く。
 */
const TAB_SYS_SEP = "@";

/** 機能 ID とシステム ref からタブ ID を組み立てる */
export function makePaneTabId(feature: string, system: string): string {
  return `${feature}${TAB_SYS_SEP}${system}`;
}

/**
 * タブ ID を機能とシステムに分ける。
 *
 * **システムを持たないタブもある**——サービス一覧・管理はこのアプリ自身の画面で、
 * IBM i のシステムに紐づかない（`LauncherPane` が `scoped: false` で開く）。
 * その場合 `system` は `undefined`。
 */
export function splitPaneTabId(id: string): { feature: string; system?: string } {
  const at = id.indexOf(TAB_SYS_SEP);
  if (at < 0) return { feature: id };
  return { feature: id.slice(0, at), system: id.slice(at + TAB_SYS_SEP.length) };
}

/** そのタブの機能 ID（システム部分を落とす） */
export function paneFeatureOf(id: string): string {
  return splitPaneTabId(id).feature;
}

/**
 * タブ帯・パンくずで使う表示名。**キーは機能 ID**（システム部分は含まない）。
 * タブ ID から引くときは `paneLabelOf` を通すこと——`PANE_LABELS[tabId]` の完全一致は
 * `@own:a` が付いた時点で外れる。
 */
export const PANE_LABELS: Record<string, string> = {
  "admin:users": "ユーザー管理",
  "admin:sessions": "セッション管理",
  "admin:logs": "ログ",
  "list:jobs": "ジョブ",
  "list:objects": "オブジェクト",
  "list:users": "ユーザー",
  "ifs:files": "IFS",
  "dtaq:entries": "データ待ち行列",
  // push 型（サーバーが常駐して待つ）。pull 型の `dtaq:entries` とは別のアプリ
  "watch:queues": "待ち行列監視",
  // サーバー側で動き続けるものの一覧（プリンターと待ち行列をまとめて見る）
  "svc:services": "サービス",
  "sql:query": "SQL",
  "transfer:data": "データ転送",
  // pull 型（既存スプールの検索・取得）。プリンターセッション（push 型）のタブとは別物
  "spool:files": "スプール"
};

/** タブ ID から表示名を引く（システム部分を落としてから引く） */
export function paneLabelOf(id: string): string | undefined {
  return PANE_LABELS[paneFeatureOf(id)];
}
