/**
 * セッションを持たないタブ（管理・一覧）の表示名。
 * タブ帯・パンくずの双方で同じ名前を出すため、1 か所に置く。
 */
export const PANE_LABELS: Record<string, string> = {
  "admin:users": "ユーザー管理",
  "admin:sessions": "セッション管理",
  "admin:logs": "ログ",
  "list:jobs": "ジョブ",
  "list:objects": "オブジェクト",
  "list:users": "ユーザー"
};
