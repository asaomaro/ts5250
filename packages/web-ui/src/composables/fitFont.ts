/** フォントサイズのクランプ範囲（px）。ScreenGrid の実測フィットと共有する。 */
export const MIN_FONT_PX = 6;
export const MAX_FONT_PX = 32;

/**
 * グリッドの内側余白（px）。**ここが唯一の定義**。
 *
 * 以前は CSS（`padding: 8px 10px`）・フィット計算（`- 20` / `- 16`）・
 * クリックの桁逆算（`- 10` / `- 8`）に**同じ数字が 3 か所**あり、
 * 余白を詰めたときに**字が大きくならず、クリック位置もずれた**（実際に踏んだ）。
 *
 * ACS はほぼ余白を持たないので小さく取る。0 にしないのは字が枠に触れると読みにくいため。
 */
export const GRID_PAD_X = 2;
export const GRID_PAD_Y = 1;

/**
 * グリッドの描画領域（px）に cols×rows の等幅グリッドが収まるフォントサイズ（px）を返す。
 * 幅・高さ両方の制約の小さい側に合わせるため、縦横どちらを縮めても縮尺が追従し、
 * オーバーフロー（スクロールバー）が出ない。
 *
 * これは**レイアウト前（ルーラー未計測）用の近似**。実描画では ScreenGrid が実測字幅で
 * フィットする（0.6em 近似だと実フォントとずれ、余白が偏る/早く縮む）。
 *
 * - 幅制約: 等幅 char 幅 ≈ 0.6em → font ≈ (w/cols)/0.6
 * - 高さ制約: 行高 1.25em → font ≈ (h/rows)/1.25
 * - グリッド padding（`GRID_PAD_X` / `GRID_PAD_Y`）を差し引く。MIN_FONT_PX〜MAX_FONT_PX にクランプ。
 */
export function fitFont(clientWidth: number, clientHeight: number, cols: number, rows: number): number {
  const w = clientWidth - GRID_PAD_X * 2;
  const h = clientHeight - GRID_PAD_Y * 2;
  const byWidth = w / cols / 0.6;
  const byHeight = h / rows / 1.25;
  return Math.max(MIN_FONT_PX, Math.min(MAX_FONT_PX, Math.min(byWidth, byHeight)));
}
