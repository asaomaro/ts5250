/**
 * ドラッグの種類を見分ける。
 *
 * ワークスペースでは 3 者が同じ `dragover` / `drop` を奪い合う:
 * ペイン分割（`WorkspaceNode`）・タブ移動（`PaneTabs`）・CSV の取り込み（`TransferPane`）。
 * **判定を 1 か所に置く**——各所で `types.includes(...)` を書くと、
 * 種類が増えたときに直し忘れる（`paneLabels.ts` が同じ理由で作られている）。
 */

/** ファイルのドラッグか。タブは `text/session` を使うので、両者は必ず判別できる */
export function isFileDrag(ev: DragEvent): boolean {
  return Array.from(ev.dataTransfer?.types ?? []).includes("Files");
}
