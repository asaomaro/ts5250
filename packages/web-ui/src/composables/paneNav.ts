/**
 * ペイン（分割グループ）間の方向フォーカス移動（DOM 非依存の純関数）。
 * 各ペインの画面矩形から、指定方向にある最も近いペインを選ぶ空間ナビゲーション。
 * 任意の分割ツリー（左右・上下・入れ子・2x2 等）で直感的に動く。
 */

export interface PaneRect {
  id: string;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export type PaneDir = "left" | "right" | "up" | "down";

/**
 * currentId のペインから dir 方向にある最も近いペインの id を返す（無ければ undefined）。
 * 採点: 主軸（移動方向）の中心間距離を基本に、副軸（直交方向）のズレを重めに罰して、
 * 素直に隣接するペインを選ぶ。反対側・同軸上のペインは候補から除外する。
 */
export function nextPaneInDirection(rects: readonly PaneRect[], currentId: string, dir: PaneDir): string | undefined {
  const cur = rects.find((r) => r.id === currentId);
  if (!cur) return undefined;
  const cxCur = (cur.left + cur.right) / 2;
  const cyCur = (cur.top + cur.bottom) / 2;

  let best: { id: string; score: number } | undefined;
  for (const r of rects) {
    if (r.id === currentId) continue;
    const cx = (r.left + r.right) / 2;
    const cy = (r.top + r.bottom) / 2;
    let primary: number; // 移動方向の距離（正=その方向にある）
    let perp: number; // 直交方向のズレ
    switch (dir) {
      case "left":
        primary = cxCur - cx;
        perp = Math.abs(cy - cyCur);
        break;
      case "right":
        primary = cx - cxCur;
        perp = Math.abs(cy - cyCur);
        break;
      case "up":
        primary = cyCur - cy;
        perp = Math.abs(cx - cxCur);
        break;
      case "down":
        primary = cy - cyCur;
        perp = Math.abs(cx - cxCur);
        break;
    }
    if (primary <= 0) continue; // 反対側・同列は対象外
    const score = primary + perp * 2; // 直交ズレを重く罰し、真隣を優先
    if (!best || score < best.score) best = { id: r.id, score };
  }
  return best?.id;
}
