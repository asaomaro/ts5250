/**
 * 実行計画グラフの座標計算。
 *
 * **`PlanGraph.vue` から切り離した純関数**にしてある——描画そのものは jsdom で確かめにくいが、
 * 座標の計算はテストできる。ここが正しければ、あとは SVG に写すだけになる。
 *
 * ## 図の形は 2 通り
 *
 * 1. **結合の木**（`block.joinTree` があるとき）。ダイヤル（`QQJNP`）を上に横並びにし、
 *    結合の節を下へ階段状に重ねる。**線はデータの流れ**（上から下）で、
 *    ACS の Visual Explain と同じ読み方になる。
 * 2. **縦並び**（結合していない計画）。ノードを 1 列に並べるだけ。
 *    **線は「同じブロックに属する」ことしか意味しない**ので、凡例で言い分ける。
 *
 * 以前は 2 だけだった。「記録に親子リンクが無い」と結論していたが、それは
 * `QQQDTN` / `QQQDTL` しか見ていなかったためで、**結合の順位は `QQJNP` が持っている**
 * （`design.md` A1 の訂正）。
 *
 * ## 依存を足さない
 *
 * d3 / dagre 等は使わない（AGENTS.md のバンドル規律。`@ts5250/scs` のバレル参照で
 * 359,853 → 1,458,480 バイトにした実例がある）。総当たりの力学配置もしない。
 * 左深の木は**列と段に落ちる**ので、汎用のグラフ配置は要らない。
 */
import type { PlanAttribute, PlanBlock, PlanNode, PlanTreeNode, PlanTreeOpKind } from "./planApi.js";

/**
 * 詳細パネルに出せるもの。**記録のノードも、導いた節（結合・プローブ・最終選択）も
 * これを満たす**ので、画面は「何を選んだか」を場合分けせずに済む。
 * `PlanNode` は構造的にこれを満たす（`id` / `label` / `attributes` を持つ）。
 */
export interface PlanSelection {
  id: string;
  label: string;
  attributes: PlanAttribute[];
}

/** ノードの箱の大きさ */
export const NODE_W = 210;
export const NODE_H = 54;
/** 箱の間隔 */
export const GAP_X = 60;
export const GAP_Y = 18;
/** ダイヤルと結合、結合どうしの縦の間隔。**線が読める程度に広く取る** */
export const JOIN_GAP_Y = 30;
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

/** 結合の節。`PlanNode` を持たないので別の型にする（詳細パネルに出すものが無い） */
export interface LaidOutJoin {
  id: string;
  label: string;
  method?: string;
  attributes: PlanAttribute[];
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 単項の節（テーブル・プローブ／最終選択）。記録ではなく記録から導いたもの */
export interface LaidOutOp {
  id: string;
  label: string;
  op: PlanTreeOpKind;
  rows?: number;
  attributes: PlanAttribute[];
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * 箱と箱を結ぶ線。
 *
 * **意味はブロックの `tree` で変わる。** 木なら「データの流れ」、
 * そうでなければ「同じブロックに属する」だけ（画面側が凡例を出し分ける）。
 */
export interface Connector {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface LaidOutBlock {
  number: number;
  x: number;
  y: number;
  nodes: LaidOutNode[];
  /** 結合の節。木として描いたときだけ入る */
  joins: LaidOutJoin[];
  /** 単項の節（テーブル・プローブ／最終選択）。木として描いたときだけ入る */
  ops: LaidOutOp[];
  connectors: Connector[];
  /** 木として描いたか。**凡例と矢印の出し分けに使う** */
  tree: boolean;
}

export interface PlanLayout {
  blocks: LaidOutBlock[];
  width: number;
  height: number;
  /** 上限で畳んだ件数。**0 でなければ画面に出す** */
  hidden: number;
}

/** ブロック 1 つぶんの配置結果（`layoutPlan` が横に並べるのに使う） */
interface BlockShape {
  nodes: LaidOutNode[];
  joins: LaidOutJoin[];
  ops: LaidOutOp[];
  connectors: Connector[];
  tree: boolean;
  /** このブロックが使った横幅 */
  width: number;
  /** 一番下の箱の下端（図の高さを決めるのに使う） */
  bottom: number;
  /** 上限で畳んだ件数 */
  hidden: number;
}

const TOP = PAD + HEADER_H;

/** 縦に n 個積んだときの下端 */
function stackBottom(count: number): number {
  return count > 0 ? TOP + count * (NODE_H + GAP_Y) - GAP_Y : TOP;
}

/** 列の中心 x（0 起点） */
function columnCenter(x0: number, i: number): number {
  return x0 + i * (NODE_W + GAP_X) + NODE_W / 2;
}

/**
 * 結合しない計画の配置。ノードを 1 列に積むだけ（従来どおり）。
 * **線は「同じブロック」**の意味しか持たない。
 */
function layoutColumn(steps: PlanNode[], x: number, budget: number): BlockShape {
  const shown = budget > 0 ? steps.slice(0, budget) : [];
  const nodes: LaidOutNode[] = shown.map((node, i) => ({
    node,
    x,
    y: TOP + i * (NODE_H + GAP_Y),
    w: NODE_W,
    h: NODE_H
  }));
  const connectors: Connector[] = [];
  for (let i = 0; i + 1 < nodes.length; i++) {
    const a = nodes[i]!;
    const b = nodes[i + 1]!;
    connectors.push({ x1: a.x + a.w / 2, y1: a.y + a.h, x2: b.x + b.w / 2, y2: b.y });
  }
  return {
    nodes,
    joins: [],
    ops: [],
    connectors,
    tree: false,
    width: NODE_W,
    bottom: stackBottom(shown.length),
    hidden: steps.length - shown.length
  };
}

/**
 * 木を開いた結果。
 *
 * - `dials`: 左から順（`QQJNP` の 1・2・3…）。図では上の段に横並びになる。
 * - `spine`: **上から下へ 1 本に伸びる背骨**。結合は右のダイヤルを 1 つ取り込み、
 *   単項の節（テーブル・プローブ／最終選択）はその下に素通しでぶら下がる。
 *
 * 左深なので木は「ダイヤルの段＋背骨」に落ちる。**汎用のグラフ配置が要らない理由**がこれ。
 */
export interface FlatJoinTree {
  dials: Extract<PlanTreeNode, { kind: "dial" }>[];
  spine: FlatSpineItem[];
}

export type FlatSpineItem =
  | { kind: "join"; id: string; label: string; method?: string; dialIndex: number; attributes: PlanAttribute[] }
  | { kind: "op"; id: string; label: string; op: PlanTreeOpKind; rows?: number; attributes: PlanAttribute[] };

/** 後方互換の別名。`joins` だけ欲しい呼び出し側のために残す */
export function joinsOf(flat: FlatJoinTree): Extract<FlatSpineItem, { kind: "join" }>[] {
  return flat.spine.filter((i): i is Extract<FlatSpineItem, { kind: "join" }> => i.kind === "join");
}

/**
 * 左深の木をダイヤルの列へ開く。
 *
 * `buildJoinTree` は右側に必ずダイヤルを置くので、**根から左へ降りれば**
 * 結合の並びが逆順に取れる。ここで想定と違う形（右が結合）を見つけたら
 * `undefined` を返す。呼び出し側は縦並び／一覧へ落とす——**描けない形を無理に描かない**。
 *
 * 図（`layoutJoinTree`）と一覧（`PlanViewer` のツリー表示）の**両方がこれを使う**。
 * 開き方が 2 か所にあると、図と一覧で並びが食い違う。
 */
export function flattenJoinTree(tree: PlanTreeNode): FlatJoinTree | undefined {
  const dialsFromRoot: Extract<PlanTreeNode, { kind: "dial" }>[] = [];
  const spineFromRoot: FlatSpineItem[] = [];
  let cur: PlanTreeNode = tree;

  // 根から左（＝下から上）へ降りる。集めた順は逆なので最後にひっくり返す
  for (;;) {
    if (cur.kind === "op") {
      spineFromRoot.push({
        kind: "op",
        id: cur.id,
        label: cur.label,
        op: cur.op,
        ...(cur.rows !== undefined ? { rows: cur.rows } : {}),
        attributes: cur.attributes
      });
      cur = cur.source;
      continue;
    }
    if (cur.kind === "join") {
      // 右がダイヤルでない形は想定外。**描けない形を無理に描かない**
      if (cur.right.kind !== "dial") return undefined;
      dialsFromRoot.push(cur.right);
      spineFromRoot.push({
        kind: "join",
        id: cur.id,
        label: cur.label,
        ...(cur.method !== undefined ? { method: cur.method } : {}),
        dialIndex: 0, // 下で付け直す
        attributes: cur.attributes
      });
      cur = cur.left;
      continue;
    }
    dialsFromRoot.push(cur);
    break;
  }

  const dials = dialsFromRoot.reverse();
  const spine = spineFromRoot.reverse();
  // 上から数えて n 本目の結合が取り込むのはダイヤル n（左深なので必ずこの順）
  let dialIndex = 0;
  for (const item of spine) if (item.kind === "join") item.dialIndex = ++dialIndex;
  return { dials, spine };
}

/**
 * 結合の木の配置。
 *
 * ```
 * [ダイヤル1]  [ダイヤル2]  [ダイヤル3]
 *     └────┬──────┘            │
 *       [結合]                 │
 *          └──────────┬────────┘
 *                  [結合]
 * ```
 *
 * ダイヤルは上に横並び、結合は下へ 1 段ずつ。**左深なので段は一直線に増える**——
 * 汎用のグラフ配置を持ち込まずに済む理由がここにある。
 */
function layoutJoinTree(tree: PlanTreeNode, others: PlanNode[], x0: number): BlockShape | undefined {
  const flat = flattenJoinTree(tree);
  if (!flat || flat.dials.length < 2) return undefined;
  const { dials, spine } = flat;

  const nodes: LaidOutNode[] = [];
  const connectors: Connector[] = [];
  let dialsBottom = TOP;

  dials.forEach((dial, i) => {
    const x = x0 + i * (NODE_W + GAP_X);
    dial.nodes.forEach((node, k) => {
      nodes.push({ node, x, y: TOP + k * (NODE_H + GAP_Y), w: NODE_W, h: NODE_H });
      // 同じダイヤルの中の縦線。**ここは記録の順**（アクセス → その上の操作）
      if (k > 0) {
        const prev = nodes[nodes.length - 2]!;
        const cur = nodes[nodes.length - 1]!;
        connectors.push({ x1: prev.x + prev.w / 2, y1: prev.y + prev.h, x2: cur.x + cur.w / 2, y2: cur.y });
      }
    });
    dialsBottom = Math.max(dialsBottom, stackBottom(dial.nodes.length));
  });

  const joins: LaidOutJoin[] = [];
  const ops: LaidOutOp[] = [];
  let y = dialsBottom + JOIN_GAP_Y;
  // 背骨の「出口」。最初はダイヤル 1 の一番下、以降は 1 つ前の節
  let prevCx = columnCenter(x0, 0);
  let prevBottom = stackBottom(dials[0]!.nodes.length);

  for (const item of spine) {
    // 結合は右のダイヤルの列へ寄る。単項の節は**そのまま真下**（取り込むものが無い）
    const cx =
      item.kind === "join" ? (prevCx + columnCenter(x0, item.dialIndex)) / 2 : prevCx;
    const box = { x: cx - NODE_W / 2, y, w: NODE_W, h: NODE_H };
    if (item.kind === "join") {
      joins.push({
        id: item.id,
        label: item.label,
        ...(item.method !== undefined ? { method: item.method } : {}),
        attributes: item.attributes,
        ...box
      });
      connectors.push({
        x1: columnCenter(x0, item.dialIndex),
        y1: stackBottom(dials[item.dialIndex]!.nodes.length),
        x2: cx,
        y2: y
      });
    } else {
      ops.push({
        id: item.id,
        label: item.label,
        op: item.op,
        ...(item.rows !== undefined ? { rows: item.rows } : {}),
        attributes: item.attributes,
        ...box
      });
    }
    connectors.push({ x1: prevCx, y1: prevBottom, x2: cx, y2: y });
    prevCx = cx;
    prevBottom = y + NODE_H;
    y += NODE_H + JOIN_GAP_Y;
  }

  // ダイヤルに属さないステップ（索引の助言など）。**木に繋がないで下に並べる**——
  // 表が同じだからと勝手に枝へ繋ぐと、根拠の無い依存を見せることになる
  const othersY = prevBottom + JOIN_GAP_Y;
  others.forEach((node, i) => {
    nodes.push({ node, x: x0 + i * (NODE_W + GAP_X), y: othersY, w: NODE_W, h: NODE_H });
  });

  const columns = Math.max(dials.length, others.length);
  return {
    nodes,
    joins,
    ops,
    connectors,
    tree: true,
    width: columns * NODE_W + (columns - 1) * GAP_X,
    bottom: others.length > 0 ? othersY + NODE_H : prevBottom,
    hidden: 0
  };
}

/**
 * ブロックを横に並べて座標を振る。
 *
 * 上限（`MAX_NODES`）は**図全体**に掛ける。ブロックごとに掛けると、
 * ブロックが多い計画で総数が上限を大きく超える。
 *
 * **木は途中で切らない。** 予算に収まらないブロックは従来どおりの縦並び＋切り詰めにする
 * ——枝が欠けた木は、繋がっていないものが繋がって見える。
 */
export function layoutPlan(blocks: PlanBlock[], maxNodes = MAX_NODES): PlanLayout {
  const out: LaidOutBlock[] = [];
  let budget = maxNodes;
  let hidden = 0;
  let x = PAD;
  let bottom = TOP;

  for (const block of blocks) {
    // **図に出すのは計画のステップだけ。** `3006`（アクセスプランの再作成）や
    // `3014`（クエリ情報）はほぼ全文で出るので、同じ列に並べると図が付帯情報で埋まる
    const steps = block.nodes.filter((n) => n.category === "step");
    const shape =
      (block.joinTree && steps.length <= budget
        ? layoutJoinTree(
            block.joinTree,
            steps.filter((n) => n.joinPosition === undefined),
            x
          )
        : undefined) ?? layoutColumn(steps, x, budget);

    budget -= shape.nodes.length;
    hidden += shape.hidden;
    bottom = Math.max(bottom, shape.bottom);
    out.push({
      number: block.number,
      x,
      y: PAD,
      nodes: shape.nodes,
      joins: shape.joins,
      ops: shape.ops,
      connectors: shape.connectors,
      tree: shape.tree
    });
    x += shape.width + GAP_X;
  }

  const width = Math.max(PAD * 2 + NODE_W, x - GAP_X + PAD);
  const height = Math.max(PAD * 2 + HEADER_H + NODE_H, bottom + PAD);
  return { blocks: out, width, height, hidden };
}

/**
 * ブロックの線。配置のときに決まっているので**そのまま返す**。
 *
 * 関数として残しているのは、画面側が「線をどう引くか」を知らずに済むため
 * （縦並びと木で本数も向きも違う）。
 */
export function connectorsOf(block: LaidOutBlock): Connector[] {
  return block.connectors;
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
