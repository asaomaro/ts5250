/**
 * **画面に重ねた部品（ポップオーバー）の共通の約束。**
 *
 * `Tab` の巡回に加えて、「その部品の上での操作は**部品が受け取り、端末へは流さない**」という
 * 線引きをここで一元化する。
 *
 * ---
 *
 * **画面に重ねる部品の集合**（`OVERLAY_SELECTOR`）。
 *
 * ホイールやキーを端末（ペイン）へ流してはいけない範囲を表す。**部品を足すたびに
 * 各ハンドラへ個別に足していくと必ず取りこぼす**——実際、ホイールの除外は
 * オプション選択肢（`.opt-hints`）にだけ入っていて日付・時刻ピッカー（`.dtp`）が漏れ、
 * **ホイールで `PageUp`/`PageDown` がホストへ飛び、再表示でピッカーが閉じていた**。
 * 新しい部品を足すときは**ここへ 1 行足す**。
 */
export const OVERLAY_SELECTOR = ".opt-hints, .dtp";

/**
 * **画面に重ねた部品の中で `Tab` を巡回させる（フォーカストラップ）。**
 *
 * オプション欄の選択肢（`.opt-hints`）と日付・時刻ピッカー（`.dtp`）が共有する。
 * 巡回させないと、末尾で `Tab` を押した瞬間に**フォーカスが部品の外へ抜け**、
 * 開いたままの部品にキーボードだけでは戻れなくなる（外側クリックでしか閉じられない）。
 * 閉じるのは `Esc`、選ぶのは `Enter` / `Space`——**出口はキーで明示的に踏む**のが約束。
 *
 * **導出元は 1 か所に置く**（2 か所に書くと片方だけ直して挙動が食い違う）。
 */

/**
 * 巡回の停止点。**`tabindex="-1"` は含めない**——日のグリッドや時刻の列は
 * ロービング tabindex（現在の 1 つだけ 0）で「まとまりで 1 停止点」にしてあり、
 * 60 個の分を Tab で 1 つずつ辿らせないため（ARIA の複合ウィジェットの作法）。
 */
export function focusStops(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'button:not([disabled]):not([tabindex="-1"]), [tabindex]:not([tabindex="-1"])'
    )
  );
}

/**
 * `Tab` / `Shift+Tab` をコンテナの中で巡回させる。**処理したら `true`**（`preventDefault` 済み）。
 *
 * 現在のフォーカスが停止点に無いとき（矢印でロービング対象外へ移った直後など）は、
 * **文書順で次にある停止点**へ送る——先頭へ飛ばすと、日を選んだ後の `Tab` が
 * カレンダーの上へ戻って見当違いに感じられる。
 */
export function cycleTab(container: HTMLElement, ev: KeyboardEvent): boolean {
  if (ev.key !== "Tab" || ev.ctrlKey || ev.metaKey || ev.altKey) return false;
  const stops = focusStops(container);
  if (stops.length === 0) return false;

  const cur = document.activeElement;
  let at = cur instanceof HTMLElement ? stops.indexOf(cur) : -1;
  if (at < 0 && cur instanceof HTMLElement && container.contains(cur)) {
    // 停止点ではない要素に居る。文書順で直後の停止点を「今いる場所」とみなす
    const after = stops.findIndex(
      (s) => (cur.compareDocumentPosition(s) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
    );
    at = after < 0 ? stops.length - 1 : after - 1;
  }
  const n = stops.length;
  const next = ev.shiftKey ? (at - 1 + n) % n : (at + 1) % n;
  stops[next]?.focus();
  ev.preventDefault();
  ev.stopPropagation();
  return true;
}
