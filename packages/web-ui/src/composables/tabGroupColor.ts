/**
 * **タブグループの色**（`20260804-tab-groups`）。
 *
 * タブを作業の単位でまとめたときの見分け。`systemColor.ts` と同じ設計方針を採る——
 * 持つのは**パレットの番号**だけで、色の実体はテーマ側の CSS 変数（`--tg-1` … `--tg-8`）にある。
 *
 * **`--sys-*` とは別のパレット**である点が要点（`spec.md` D7）。システムカラーは
 * 「どのシステムか」、タブグループは「どの作業か」で軸が違い、同じ 8 色を共有すると
 * **同じ色が 2 つの意味を持つ**（同じタブ帯の中に両方が並ぶので、読み手は区別できない）。
 *
 * **番号は利用者が選ぶ**（システムカラーのように ref から導出しない）。グループは
 * 利用者がその場で作るもので、名前も付いていないことがある——**自分で選んだ色**であることが
 * 見分けの手掛かりになる。新規作成時の初期値だけ `nextTabGroupColor` が決める。
 */

/** パレットの色数。`--tg-1` … `--tg-8` に対応する */
export const TAB_GROUP_COLOR_COUNT = 8;

/** その番号の CSS 変数（チップの塗り・タブの背景・下線に使う） */
export function tabGroupColorVar(index: number): string {
  return `var(--tg-${index})`;
}

/**
 * 新規グループに割り当てる色。**使われていない最小の番号**を選ぶ。
 *
 * 全色が埋まっていたら使用数が最も少ない番号へ倒す（同数なら小さい方）。
 * 乱数を使わないのは、同じ手順を踏めば同じ色になる＝説明できる挙動にするため。
 */
export function nextTabGroupColor(used: readonly number[]): number {
  const count = new Array<number>(TAB_GROUP_COLOR_COUNT + 1).fill(0);
  for (const u of used) {
    if (Number.isInteger(u) && u >= 1 && u <= TAB_GROUP_COLOR_COUNT) count[u]!++;
  }
  let best = 1;
  for (let i = 2; i <= TAB_GROUP_COLOR_COUNT; i++) {
    if (count[i]! < count[best]!) best = i;
  }
  return best;
}

/**
 * 受け取った番号を正規化する。**範囲外・壊れた値は自動に倒す**
 * （`systemColorIndex` と同じ「色が消えるより何か付くほうがよい」方針）。
 */
export function tabGroupColorIndex(value: unknown, fallback = 1): number {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= TAB_GROUP_COLOR_COUNT
    ? value
    : fallback;
}
