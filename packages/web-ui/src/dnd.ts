/**
 * ドラッグの種類を見分ける。
 *
 * ワークスペースでは 4 者が同じ `dragover` / `drop` を奪い合う:
 * ペイン分割（`WorkspaceNode`）・タブ移動（`PaneTabs`）・**タブグループ移動**（`PaneTabs` のチップ）・
 * CSV の取り込み（`TransferPane`）。
 * **判定を 1 か所に置く**——各所で `types.includes(...)` を書くと、
 * 種類が増えたときに直し忘れる（`paneLabels.ts` が同じ理由で作られている）。
 */

/** タブ 1 枚のドラッグ（`PaneTabs` が `dragstart` で載せる） */
export const TAB_MIME = "text/session";

/**
 * タブグループごとのドラッグ（チップを掴んだとき。`20260804-tab-groups`）。
 *
 * **タブと別の型にする**のが要点——受け手（タブ帯・ペインの端）は「1 枚が来たのか
 * グループが来たのか」で処理が変わる。同じ型に載せて中身で見分ける形にすると、
 * `dragover` の時点では `getData` が読めないので判定できない。
 */
export const TAB_GROUP_MIME = "text/tabgroup";

/** ファイルのドラッグか。タブは `text/session` を使うので、両者は必ず判別できる */
export function isFileDrag(ev: DragEvent): boolean {
  return Array.from(ev.dataTransfer?.types ?? []).includes("Files");
}

/** タブグループごとのドラッグか（`dragover` でも読めるよう `types` で見る） */
export function isTabGroupDrag(ev: DragEvent): boolean {
  return Array.from(ev.dataTransfer?.types ?? []).includes(TAB_GROUP_MIME);
}
