import { describe, it, expect } from "vitest";
import {
  layoutPlan,
  connectorsOf,
  nodeClassOf,
  NODE_W,
  NODE_H,
  GAP_X,
  GAP_Y,
  PAD,
  HEADER_H
} from "../src/planLayout.js";
import type { PlanBlock, PlanNode } from "../src/planApi.js";

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
