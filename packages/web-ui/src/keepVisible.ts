/**
 * 一覧の中で「選んでいる項目」を見える位置に保つためのスクロール量。
 *
 * **描画から切り離した純関数**にしてある——jsdom では `offsetTop` も `clientHeight` も
 * 0 なので、コンポーネントのままでは計算を試せない。数値だけをここで確かめ、
 * 画面側は測った値を渡して結果を `scrollTop` に入れるだけにする。
 */

export interface Viewport {
  /** いまのスクロール量 */
  scrollTop: number;
  /** 見えている高さ（`clientHeight`） */
  height: number;
}

export interface Item {
  /** 一覧の先頭からの位置（`offsetTop`） */
  top: number;
  /** 項目の高さ（`offsetHeight`） */
  height: number;
}

/**
 * 項目が収まる最小のスクロール量を返す。
 *
 * - 上にはみ出していれば**項目の上端**に合わせる
 * - 下にはみ出していれば**項目の下端**に合わせる
 * - 収まっていれば**動かさない**（読んでいる途中で勝手に動くのが一番うるさい）
 *
 * 項目が枠より高いときは上端を優先する（先頭が読めないと何の項目か分からない）。
 */
export function scrollToShow(view: Viewport, item: Item): number {
  if (item.top < view.scrollTop) return item.top;
  const bottom = item.top + item.height;
  if (bottom > view.scrollTop + view.height) {
    // 枠より高い項目は上端に寄せる（下端に合わせると先頭が切れる）
    return item.height >= view.height ? item.top : bottom - view.height;
  }
  return view.scrollTop;
}
