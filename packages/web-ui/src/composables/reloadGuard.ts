/**
 * **キーボードからの再読み込み（F5・Ctrl+R）を止める。**
 *
 * 再読み込みするとブラウザ ↔ サーバーの WebSocket が閉じ、ページは前のセッションへ自動では戻らない
 * （サーバーは `--reconnect-grace` の猶予のあとホストへの接続を閉じる）。F5 は 5250 のファンクションキーでもあり、
 * エミュレーターの外（ランチャー・設定・一覧）にフォーカスがあるとき押すと、そのままブラウザの再読み込みになって
 * 開いているセッションを全部失う——誤操作の代償が大きいので、キーからの再読み込みだけを止める（利用者の指示）。
 *
 * **止めないもの**（意図して再読み込みする口は残す）:
 * - ブラウザの再読み込みボタン（ページからは止められないし、止めない）
 * - `Ctrl+Shift+R`・`Ctrl+F5`・`Shift+F5`（キャッシュを捨てる再読み込み）
 *
 * **`preventDefault` だけで、伝播は止めない。** F5 はエミュレーターのペインが AID キーとして受け取るので、
 * そちらの処理はそのまま走らせる（`window` のバブル段に付けるので、ペインの処理より後に呼ばれる）。
 */

/** 止める対象のキーか。修飾キーの組は「素の F5」「Ctrl+R」だけ（Shift 付きは強制の再読み込みなので通す） */
export function isReloadKey(ev: Pick<KeyboardEvent, "key" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey">): boolean {
  if (ev.shiftKey || ev.altKey || ev.metaKey) return false;
  if (ev.key === "F5") return !ev.ctrlKey;
  return ev.ctrlKey && ev.key.toLowerCase() === "r";
}

function onKeydown(ev: KeyboardEvent): void {
  if (isReloadKey(ev)) ev.preventDefault();
}

/** 入口（`main.ts` / `embed.ts`）で 1 回呼ぶ。戻り値は取り外し（テスト用） */
export function installReloadGuard(target: Pick<Window, "addEventListener" | "removeEventListener"> = window): () => void {
  target.addEventListener("keydown", onKeydown as EventListener);
  return () => target.removeEventListener("keydown", onKeydown as EventListener);
}
