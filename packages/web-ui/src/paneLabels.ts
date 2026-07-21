/**
 * セッションを持たないタブ（管理・一覧・SQL）の定義。
 *
 * タブ帯・パンくず・ヘッダーのトグル出し分けが同じ判定を使うため、1 か所に置く。
 * **プレフィックスの一覧をここに集約している**——以前 `list:*` を `PaneTabs` の判定に
 * 足し忘れ、タブを閉じたときに「セッションの切断」処理へ流れる不具合が出た。
 * 種類が増えるたび各所の `startsWith` を直して回る形だと同じことが再発する。
 */

/** セッションを持たないタブの ID 接頭辞。**新しい種類を足すときはここに追加する** */
export const PANE_PREFIXES = ["admin:", "dtaq:", "ifs:", "list:", "sql:", "transfer:"] as const;

/** セッションを持たない（＝接続の概念が無い）タブか */
export function isPaneTab(id: string | undefined): boolean {
  return Boolean(id) && PANE_PREFIXES.some((p) => id!.startsWith(p));
}

/** タブ帯・パンくずで使う表示名 */
export const PANE_LABELS: Record<string, string> = {
  "admin:users": "ユーザー管理",
  "admin:sessions": "セッション管理",
  "admin:logs": "ログ",
  "list:jobs": "ジョブ",
  "list:objects": "オブジェクト",
  "list:users": "ユーザー",
  "ifs:files": "IFS",
  "dtaq:entries": "データ待ち行列",
  "sql:query": "SQL",
  "transfer:data": "データ転送"
};
