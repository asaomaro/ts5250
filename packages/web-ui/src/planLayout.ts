/**
 * 実行計画グラフの座標計算。
 *
 * **`PlanGraph.vue` から切り離した純関数**にしてある——描画そのものは jsdom で確かめにくいが、
 * 座標の計算はテストできる。ここが正しければ、あとは SVG に写すだけになる。
 *
 * ## 図の形
 *
 * 計画は**文 → クエリブロック（`QQQDTN`）→ ノード**の 3 層で、
 * **演算子の親子関係は持っていない**（`design.md` 判断 A1。実測で `QQQDTN` は
 * ブロック番号であって階層ではないと分かった）。
 * よって**推定で木を描かない**。ブロックを列、ノードを行として並べ、
 * ブロックが複数ある（UNION など）ときだけ列が増える。
 *
 * ## 依存を足さない
 *
 * d3 / dagre 等は使わない（AGENTS.md のバンドル規律。`@ts5250/scs` のバレル参照で
 * 359,853 → 1,458,480 バイトにした実例がある）。総当たりの力学配置もしない。
 */
import type { PlanBlock, PlanNode } from "./planApi.js";

/** ノードの箱の大きさ */
export const NODE_W = 210;
export const NODE_H = 54;
/** 箱の間隔 */
export const GAP_X = 60;
export const GAP_Y = 18;
/** 図の余白 */
export const PAD = 16;
/** ブロック見出しのぶんの縦オフセット */
export const HEADER_H = 22;

/**
 * 1 つの図に描くノード数の上限。
 * 超えた分は畳んで「他 n 件」を出す（**黙って切らない**）。
 */
export const MAX_NODES = 60;

export interface LaidOutNode {
  node: PlanNode;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LaidOutBlock {
  number: number;
  x: number;
  y: number;
  nodes: LaidOutNode[];
}

export interface PlanLayout {
  blocks: LaidOutBlock[];
  width: number;
  height: number;
  /** 上限で畳んだ件数。**0 でなければ画面に出す** */
  hidden: number;
}

/**
 * ブロックを列、ノードを行にして座標を振る。
 *
 * 上限（`MAX_NODES`）は**図全体**に掛ける。ブロックごとに掛けると、
 * ブロックが多い計画で総数が上限を大きく超える。
 */
export function layoutPlan(blocks: PlanBlock[], maxNodes = MAX_NODES): PlanLayout {
  const out: LaidOutBlock[] = [];
  let budget = maxNodes;
  let hidden = 0;
  let x = PAD;
  let maxRows = 0;

  for (const block of blocks) {
    // **図に出すのは計画のステップだけ。** `3006`（アクセスプランの再作成）や
    // `3014`（クエリ情報）はほぼ全文で出るので、同じ列に並べると図が付帯情報で埋まる
    const steps = block.nodes.filter((n) => n.category === "step");
    const shown = budget > 0 ? steps.slice(0, budget) : [];
    hidden += steps.length - shown.length;
    budget -= shown.length;
    // **空になったブロックも列として残す**——「このブロックは畳まれた」と分かるように
    const nodes: LaidOutNode[] = shown.map((node, i) => ({
      node,
      x,
      y: PAD + HEADER_H + i * (NODE_H + GAP_Y),
      w: NODE_W,
      h: NODE_H
    }));
    out.push({ number: block.number, x, y: PAD, nodes });
    maxRows = Math.max(maxRows, shown.length);
    x += NODE_W + GAP_X;
  }

  const width = Math.max(PAD * 2 + NODE_W, x - GAP_X + PAD);
  const height = PAD * 2 + HEADER_H + Math.max(1, maxRows) * (NODE_H + GAP_Y) - GAP_Y;
  return { blocks: out, width, height, hidden };
}

/**
 * ブロック内の連なりを示す線（上のノード → 下のノード）。
 *
 * **これはデータの流れではない。** 記録に親子は無いので、
 * 「同じブロックに属する」ことだけを縦線で示す（画面側で凡例を出す）。
 */
export interface Connector {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export function connectorsOf(block: LaidOutBlock): Connector[] {
  const out: Connector[] = [];
  for (let i = 0; i + 1 < block.nodes.length; i++) {
    const a = block.nodes[i]!;
    const b = block.nodes[i + 1]!;
    out.push({ x1: a.x + a.w / 2, y1: a.y + a.h, x2: b.x + b.w / 2, y2: b.y });
  }
  return out;
}

/**
 * ノードの色分けに使うクラス名。
 *
 * **種別は 17 通りあるが、色は 4 系統に畳む**——17 色に塗り分けても読み手は覚えられないし、
 * 生色が増える（`docs/UI-DESIGN.md`「配色は CSS 変数で一元化し、生色を避ける」）。
 * 種別そのものはノードのラベルと属性で分かる。
 */
export function nodeClassOf(node: PlanNode): string {
  switch (node.kind) {
    case "table-scan":
    case "index-used":
    case "index-created":
      return "pn-access";
    case "sort":
    case "temp-table":
    case "temp-hash-table":
    case "bitmap-created":
    case "distinct":
    case "set-operation":
    case "grouping":
    case "subquery":
      return "pn-operation";
    case "index-advised":
      return "pn-advice";
    case "other":
      return "pn-other";
    default:
      return "pn-info";
  }
}
