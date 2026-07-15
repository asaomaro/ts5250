/**
 * グリッドの描画領域（px）に cols×rows の等幅グリッドが収まるフォントサイズ（px）を返す。
 * 幅・高さ両方の制約の小さい側に合わせるため、縦横どちらを縮めても縮尺が追従し、
 * オーバーフロー（スクロールバー）が出ない。
 *
 * - 幅制約: 等幅 char 幅 ≈ 0.6em → font ≈ (w/cols)/0.6
 * - 高さ制約: 行高 1.25em → font ≈ (h/rows)/1.25
 * - グリッド padding（8px 10px）を差し引く。6〜22px にクランプ。
 */
export function fitFont(clientWidth: number, clientHeight: number, cols: number, rows: number): number {
  const w = clientWidth - 20; // padding 10px * 2
  const h = clientHeight - 16; // padding 8px * 2
  const byWidth = w / cols / 0.6;
  const byHeight = h / rows / 1.25;
  return Math.max(6, Math.min(22, Math.min(byWidth, byHeight)));
}
