import { describe, it, expect } from "vitest";
import {
  layoutPlan,
  connectorsOf,
  flattenJoinTree,
  joinsOf,
  nodeClassOf,
  NODE_W,
  NODE_H,
  GAP_X,
  GAP_Y,
  JOIN_GAP_Y,
  PAD,
  HEADER_H
} from "../src/planLayout.js";
import type { PlanBlock, PlanNode, PlanTreeNode } from "../src/planApi.js";

/**
 * グラフの座標計算。**描画は jsdom で確かめにくいが、座標はテストできる**ので
 * 純関数に切ってある（`planLayout.ts` の注記）。
 */
const node = (id: string, over: Partial<PlanNode> = {}): PlanNode => ({
  id,
  kind: "table-scan",
  // **図に出るのは step だけ**なので、レイアウトの検証には step を使う
  category: "step",
  recordType: 3000,
  label: `node ${id}`,
  attributes: [],
  ...over
});

const block = (number: number, count: number): PlanBlock => ({
  number,
  nodes: Array.from({ length: count }, (_, i) => node(`${number}-${i}`))
});

describe("ブロックは列・ノードは行", () => {
  it("1 ブロックならノードが縦に並ぶ", () => {
    const l = layoutPlan([block(1, 3)]);
    const ys = l.blocks[0]!.nodes.map((n) => n.y);
    expect(ys).toEqual([
      PAD + HEADER_H,
      PAD + HEADER_H + (NODE_H + GAP_Y),
      PAD + HEADER_H + 2 * (NODE_H + GAP_Y)
    ]);
    // 同じ列なので x は同じ
    expect(new Set(l.blocks[0]!.nodes.map((n) => n.x)).size).toBe(1);
  });

  it("ブロックが増えると列が右へ伸びる（UNION など）", () => {
    const l = layoutPlan([block(1, 2), block(2, 1)]);
    expect(l.blocks[0]!.x).toBe(PAD);
    expect(l.blocks[1]!.x).toBe(PAD + NODE_W + GAP_X);
  });

  it("図の大きさは一番背の高い列に合わせる", () => {
    const l = layoutPlan([block(1, 1), block(2, 4)]);
    expect(l.height).toBe(PAD * 2 + HEADER_H + 4 * (NODE_H + GAP_Y) - GAP_Y);
    expect(l.width).toBe(PAD * 2 + NODE_W * 2 + GAP_X);
  });

  it("ブロックが無くても潰れない", () => {
    const l = layoutPlan([]);
    expect(l.width).toBeGreaterThan(0);
    expect(l.height).toBeGreaterThan(0);
    expect(l.blocks).toEqual([]);
  });
});

describe("上限で畳む", () => {
  it("**上限は図全体に掛かる**（ブロックごとではない）", () => {
    const l = layoutPlan([block(1, 5), block(2, 5)], 6);
    const shown = l.blocks.reduce((n, b) => n + b.nodes.length, 0);
    expect(shown).toBe(6);
    expect(l.hidden).toBe(4);
  });

  it("畳んだ件数を返す（**黙って切らない**ため画面が出せる）", () => {
    const l = layoutPlan([block(1, 10)], 3);
    expect(l.hidden).toBe(7);
  });

  it("上限に収まるなら畳まない", () => {
    const l = layoutPlan([block(1, 2)], 60);
    expect(l.hidden).toBe(0);
  });

  it("畳まれて空になったブロックも列として残る（そこに何かあったと分かる）", () => {
    const l = layoutPlan([block(1, 3), block(2, 3)], 3);
    expect(l.blocks).toHaveLength(2);
    expect(l.blocks[1]!.nodes).toEqual([]);
  });
});

describe("連結線", () => {
  it("ブロック内で上下のノードを結ぶ（n-1 本）", () => {
    const l = layoutPlan([block(1, 3)]);
    expect(connectorsOf(l.blocks[0]!)).toHaveLength(2);
  });

  it("ノードが 1 つなら線は無い", () => {
    const l = layoutPlan([block(1, 1)]);
    expect(connectorsOf(l.blocks[0]!)).toEqual([]);
  });

  it("線は箱の下端から次の箱の上端へ引く", () => {
    const l = layoutPlan([block(1, 2)]);
    const [c] = connectorsOf(l.blocks[0]!);
    const [a, b] = l.blocks[0]!.nodes;
    expect(c!.y1).toBe(a!.y + NODE_H);
    expect(c!.y2).toBe(b!.y);
    expect(c!.x1).toBe(c!.x2);
  });
});

describe("種別のクラス名", () => {
  it("種別ごとに別のクラスになる（**生色を書かず CSS 変数に寄せる**ため）", () => {
    // **17 種を 4 系統に畳む**（17 色に塗り分けても読み手が覚えられない）
    expect(nodeClassOf(node("a", { kind: "table-scan" }))).toBe("pn-access");
    expect(nodeClassOf(node("a", { kind: "index-used" }))).toBe("pn-access");
    expect(nodeClassOf(node("a", { kind: "sort" }))).toBe("pn-operation");
    expect(nodeClassOf(node("a", { kind: "set-operation" }))).toBe("pn-operation");
    expect(nodeClassOf(node("a", { kind: "index-advised" }))).toBe("pn-advice");
    expect(nodeClassOf(node("a", { kind: "statistics" }))).toBe("pn-info");
    expect(nodeClassOf(node("a", { kind: "other" }))).toBe("pn-other");
  });
});

/**
 * 結合の木。**ダイヤルを上に横並び、結合を下へ階段状に**置く（ACS と同じ読み方）。
 * 順位は `QQJNP` が持っているので推定は入らない（`design.md` A1 の訂正）。
 */
describe("結合の木", () => {
  const dialNode = (id: string, position: number): PlanNode =>
    node(id, { joinPosition: position });

  /** 左深の木を組む（`buildJoinTree` が返す形と同じ） */
  function joinTree(dialCounts: number[]): { tree: PlanTreeNode; nodes: PlanNode[] } {
    const nodes: PlanNode[] = [];
    const dials = dialCounts.map((count, i) => {
      const list = Array.from({ length: count }, (_, k) => dialNode(`d${i + 1}-${k}`, i + 1));
      nodes.push(...list);
      return { kind: "dial" as const, id: `1-d${i + 1}`, position: i + 1, nodes: list };
    });
    let tree: PlanTreeNode = dials[0]!;
    for (let i = 1; i < dials.length; i++) {
      tree = {
        kind: "join",
        id: `1-j${i}`,
        label: "ネステッドループ結合",
        method: "NL",
        left: tree,
        right: dials[i]!,
        attributes: [{ label: "結合方式", value: "NL" }]
      };
    }
    return { tree, nodes };
  }

  const treeBlock = (dialCounts: number[], others: PlanNode[] = []): PlanBlock => {
    const { tree, nodes } = joinTree(dialCounts);
    return { number: 1, nodes: [...nodes, ...others], joinTree: tree };
  };

  it("ダイヤルは列として横に並ぶ", () => {
    const l = layoutPlan([treeBlock([1, 1])]);
    const xs = l.blocks[0]!.nodes.map((n) => n.x);
    expect(xs).toEqual([PAD, PAD + NODE_W + GAP_X]);
    // 同じ段（横並び）
    expect(new Set(l.blocks[0]!.nodes.map((n) => n.y)).size).toBe(1);
  });

  it("結合はダイヤルより下、2 つの列の真ん中に置く", () => {
    const l = layoutPlan([treeBlock([1, 1])]);
    const [j] = l.blocks[0]!.joins;
    expect(j).toBeDefined();
    // ダイヤルの下端（1 段ぶん）＋ 間隔
    expect(j!.y).toBe(PAD + HEADER_H + NODE_H + JOIN_GAP_Y);
    // 列 0 と列 1 の中心の中点
    const c0 = PAD + NODE_W / 2;
    const c1 = PAD + NODE_W + GAP_X + NODE_W / 2;
    expect(j!.x + NODE_W / 2).toBe((c0 + c1) / 2);
  });

  it("3 表なら結合が 2 つ、下へ 1 段ずつ重なる", () => {
    const l = layoutPlan([treeBlock([1, 1, 1])]);
    const joins = l.blocks[0]!.joins;
    expect(joins).toHaveLength(2);
    expect(joins[1]!.y).toBe(joins[0]!.y + NODE_H + JOIN_GAP_Y);
  });

  it("線は結合ごとに 2 本（左の子と右のダイヤルから）", () => {
    const l = layoutPlan([treeBlock([1, 1])]);
    expect(connectorsOf(l.blocks[0]!)).toHaveLength(2);
    // どの線も下向き（データの流れ）
    for (const c of connectorsOf(l.blocks[0]!)) expect(c.y2).toBeGreaterThan(c.y1);
  });

  it("同じダイヤルに複数の記録があれば縦に積み、その中も線で結ぶ", () => {
    const l = layoutPlan([treeBlock([2, 1])]);
    const first = l.blocks[0]!.nodes.filter((n) => n.x === PAD);
    expect(first).toHaveLength(2);
    expect(first[1]!.y).toBe(first[0]!.y + NODE_H + GAP_Y);
    // ダイヤル内 1 本＋結合 2 本
    expect(connectorsOf(l.blocks[0]!)).toHaveLength(3);
  });

  it("**木として描いたことを印にする**（凡例の文言が線の意味と食い違わないように）", () => {
    expect(layoutPlan([treeBlock([1, 1])]).blocks[0]!.tree).toBe(true);
    expect(layoutPlan([block(1, 2)]).blocks[0]!.tree).toBe(false);
  });

  it("ダイヤルに属さないステップは木の下に置き、線で繋がない", () => {
    const other = node("adv", { kind: "index-advised" });
    const l = layoutPlan([treeBlock([1, 1], [other])]);
    const laid = l.blocks[0]!.nodes.find((n) => n.node.id === "adv")!;
    expect(laid.y).toBeGreaterThan(l.blocks[0]!.joins[0]!.y);
    // 線は結合ぶんの 2 本のまま（勝手に枝へ繋がない）
    expect(connectorsOf(l.blocks[0]!)).toHaveLength(2);
  });

  it("**予算に収まらないブロックは木にしない**（枝の欠けた木を描かない）", () => {
    const l = layoutPlan([treeBlock([2, 2])], 3);
    expect(l.blocks[0]!.tree).toBe(false);
    expect(l.hidden).toBe(1);
  });

  it("次のブロックは木の幅ぶん右から始まる（UNION と結合の混在）", () => {
    const l = layoutPlan([treeBlock([1, 1]), block(2, 1)]);
    expect(l.blocks[1]!.x).toBe(PAD + (NODE_W * 2 + GAP_X) + GAP_X);
  });

  it("木を開くとダイヤルと背骨が順に取れる（図と一覧で並びを揃えるため）", () => {
    const { tree } = joinTree([1, 1, 1]);
    const flat = flattenJoinTree(tree)!;
    expect(flat.dials.map((d) => d.position)).toEqual([1, 2, 3]);
    // 背骨は上から。結合が 2 つ、それぞれ取り込むダイヤルの番号を持つ
    expect(joinsOf(flat).map((j) => j.dialIndex)).toEqual([1, 2]);
  });
});

/**
 * ACS の Visual Explain には出ていて、記録そのものには無いもの。
 * **導いたと分かるように**別の見た目にする（`op` として木に載る）。
 */
describe("導いた節（テーブル・プローブ／最終選択）", () => {
  /** ダイヤル 2 のあとにプローブ、根に最終選択（実機の 2 表結合と同じ形） */
  function withOps(): PlanBlock {
    const d1: PlanTreeNode = { kind: "dial", id: "1-d1", position: 1, nodes: [node("a", { joinPosition: 1 })] };
    const d2: PlanTreeNode = { kind: "dial", id: "1-d2", position: 2, nodes: [node("b", { joinPosition: 2 })] };
    const join: PlanTreeNode = {
      kind: "join",
      id: "1-j1",
      label: "ネステッドループ結合",
      left: d1,
      right: d2,
      attributes: [{ label: "結合方式", value: "NL" }]
    };
    const probe: PlanTreeNode = {
      kind: "op",
      id: "1-p1",
      label: "テーブル・プローブ: T",
      op: "table-probe",
      source: join,
      attributes: [{ label: "この節の根拠", value: "索引だけでは列が揃わない（索引のみアクセス = N）" }]
    };
    const final: PlanTreeNode = {
      kind: "op",
      id: "1-final",
      label: "最終選択",
      op: "final-select",
      rows: 8,
      source: probe,
      attributes: [{ label: "返した行数", value: "8" }]
    };
    return { number: 1, nodes: [node("a", { joinPosition: 1 }), node("b", { joinPosition: 2 })], joinTree: final };
  }

  it("結合の下に真下へ積む（取り込むものが無いので列は動かさない）", () => {
    const l = layoutPlan([withOps()]);
    const b = l.blocks[0]!;
    expect(b.ops.map((o) => o.op)).toEqual(["table-probe", "final-select"]);
    const j = b.joins[0]!;
    // 真下＝同じ中心 x
    expect(b.ops[0]!.x).toBe(j.x);
    expect(b.ops[1]!.x).toBe(j.x);
    expect(b.ops[0]!.y).toBe(j.y + NODE_H + JOIN_GAP_Y);
    expect(b.ops[1]!.y).toBe(b.ops[0]!.y + NODE_H + JOIN_GAP_Y);
  });

  it("背骨は 1 本に繋がる（結合 → プローブ → 最終選択）", () => {
    const l = layoutPlan([withOps()]);
    // ダイヤル 1→結合・ダイヤル 2→結合・結合→プローブ・プローブ→最終選択
    expect(connectorsOf(l.blocks[0]!)).toHaveLength(4);
  });

  it("最終選択は行数を持つ（ACS の「最終選択」の数字＝`3019` の QQI7）", () => {
    const l = layoutPlan([withOps()]);
    expect(l.blocks[0]!.ops.find((o) => o.op === "final-select")?.rows).toBe(8);
  });

  /** 導いた節も**選んで詳細が見られる**（ACS と同じ）。属性が配置まで届いているか */
  it("結合と単項の節に属性が付いてくる（詳細パネルに出せる）", () => {
    const b = layoutPlan([withOps()]).blocks[0]!;
    expect(b.joins[0]!.attributes.map((a) => a.label)).toContain("結合方式");
    expect(b.ops.find((o) => o.op === "table-probe")!.attributes.map((a) => a.label)).toContain("この節の根拠");
    expect(b.ops.find((o) => o.op === "final-select")!.attributes.map((a) => a.label)).toContain("返した行数");
  });

  it("図の高さは一番下の節まで伸びる", () => {
    const l = layoutPlan([withOps()]);
    const last = l.blocks[0]!.ops[1]!;
    expect(l.height).toBe(last.y + NODE_H + PAD);
  });
});
