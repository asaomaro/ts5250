/**
 * **システムカラー**（`20260802-tabs-own-system`）。
 *
 * 異なるシステムのタブを並べたときの見分けに使う。持つのは**パレットの番号**だけで、
 * 色の実体はテーマ側の CSS 変数（`--sys-1` … `--sys-8`）にある——設定ファイルに hex を
 * 書くと、テーマや配色を変えるたびに設定を直して回ることになる。
 *
 * **出す場所は 3 か所だけ**（利用者の指示）: タブ・ヘッダーのシステム名・メニュー。
 * **エミュレータ画面（`.grid`）の中には一切入れない**——画面の中の色はホストが意味に
 * 使っている（赤＝エラー・黄＝注意）ので、混ぜると印の意味が濁る。
 *
 * **文字を着色しない**（帯と点で示す）。パレット色は全テーマで文字色としての
 * コントラストを保証できず、タブの文字色は既にアクティブ／非アクティブを表しているため。
 */

/** パレットの色数。`--sys-1` … `--sys-8` に対応する */
export const SYSTEM_COLOR_COUNT = 8;

/**
 * 未設定のシステムに割り当てる番号を **ref から決定的に**導く。
 *
 * 登録しただけで区別が付くようにするため。同じ ref なら常に同じ色になるので、
 * 再読み込みや別のブラウザでも見え方が変わらない（設定を持ち回らずに済む）。
 */
export function autoSystemColor(ref: string): number {
  let h = 0;
  for (let i = 0; i < ref.length; i++) h = (h * 31 + ref.charCodeAt(i)) >>> 0;
  return (h % SYSTEM_COLOR_COUNT) + 1;
}

/**
 * そのシステムのパレット番号。設定値が無ければ自動。
 * **範囲外・未知の値は自動に倒す**（壊れた設定で色が消えるより、何か付くほうがよい）。
 */
export function systemColorIndex(ref: string, configured?: number): number {
  if (
    typeof configured === "number" &&
    Number.isInteger(configured) &&
    configured >= 1 &&
    configured <= SYSTEM_COLOR_COUNT
  ) {
    return configured;
  }
  return autoSystemColor(ref);
}

/** その番号の CSS 変数（`var(--sys-N)`）。帯・点の色に使う */
export function systemColorVar(index: number): string {
  return `var(--sys-${index})`;
}
