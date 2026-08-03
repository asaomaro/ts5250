import { describe, it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";
import PlanViewer from "../src/components/PlanViewer.vue";
import { MSG_PLAN_UNKNOWN_RECORDS } from "../src/composables/opMessages.js";
import type { IndexAdvice, PlanNode, QueryPlan } from "../src/planApi.js";

/**
 * 計画ビューア。
 *
 * 見るべきは 3 点:
 * 1. グラフ／ツリーを切り替えられ、**どちらでも同じノードが見える**
 * 2. **知らない記録種別を隠さない**（`other` として出し、種別番号も示す）
 * 3. 索引の作成は**確認を取ってから**（取り消せない操作）
 */
const node = (over: Partial<PlanNode> = {}): PlanNode => ({
  id: "1-0",
  kind: "table-scan",
  category: "step",
  recordType: 3000,
  label: "表アクセス: SYSCOLUMNS",
  attributes: [{ label: "記録種別", value: "3000" }],
  ...over
});

const advice: IndexAdvice = {
  table: { schema: "QSYS2", name: "SYSCOLUMNS" },
  keyColumns: "DBIREL, DBILB2",
  createStatement: "CREATE INDEX QSYS2.SYSCOLUMNS_IX1 ON QSYS2.SYSCOLUMNS (DBIREL, DBILB2)"
};

function plan(over: Partial<QueryPlan> = {}): QueryPlan {
  return {
    statement: "SELECT COUNT(*) FROM QSYS2.SYSCOLUMNS",
    captured: "run",
    at: "2026-08-02T00:00:00Z",
    blocks: [{ number: 1, nodes: [node()] }],
    advice: [],
    summary: {
      nodeCount: 1,
      stepCount: 1,
      blockCount: 1,
      tables: ["QSYS2.SYSCOLUMNS"],
      indexes: ["QADBILLB"],
      adviceCount: 0,
      maxEstimatedMs: 12
    },
    unknownRecordTypes: [],
    ...over
  };
}

describe("グラフ／ツリーの切替", () => {
  it("既定はグラフ（SVG が出る）", () => {
    const w = mount(PlanViewer, { props: { plan: plan() } });
    expect(w.find("svg").exists()).toBe(true);
  });

  it("ツリーに切り替えると SVG が消えてツリーが出る", async () => {
    const w = mount(PlanViewer, { props: { plan: plan() } });
    await w.findAll("button").find((b) => b.text() === "ツリー")!.trigger("click");
    expect(w.find("svg").exists()).toBe(false);
    expect(w.text()).toContain("表アクセス: SYSCOLUMNS");
  });

  it("どちらの表示でも同じノードのラベルが見える", async () => {
    const w = mount(PlanViewer, { props: { plan: plan() } });
    expect(w.text()).toContain("表アクセス: SYSCOLUMNS");
    await w.findAll("button").find((b) => b.text() === "ツリー")!.trigger("click");
    expect(w.text()).toContain("表アクセス: SYSCOLUMNS");
  });

  it("要約（表・索引・推定）が出る", () => {
    const w = mount(PlanViewer, { props: { plan: plan() } });
    expect(w.text()).toContain("QSYS2.SYSCOLUMNS");
    expect(w.text()).toContain("QADBILLB");
    expect(w.text()).toContain("12 ms");
  });
});

describe("ノードの詳細", () => {
  it("選ぶ前は案内を出す", () => {
    const w = mount(PlanViewer, { props: { plan: plan() } });
    expect(w.text()).toContain("ノードを選ぶと詳細が出ます");
  });

  it("ツリーでノードを選ぶと属性が出る", async () => {
    const p = plan({
      blocks: [{ number: 1, nodes: [node({ attributes: [{ label: "理由コード", value: "I1" }] })] }]
    });
    const w = mount(PlanViewer, { props: { plan: p } });
    await w.findAll("button").find((b) => b.text() === "ツリー")!.trigger("click");
    await w.find(".pv-tree-node").trigger("click");
    expect(w.text()).toContain("理由コード");
    expect(w.text()).toContain("I1");
  });
});

describe("知らない記録種別", () => {
  it("**種別番号をそのまま出す**（推測でラベルを付けない）", () => {
    const p = plan({
      blocks: [{ number: 1, nodes: [node({ kind: "other", recordType: 3015, label: "記録 3015" })] }]
    });
    const w = mount(PlanViewer, { props: { plan: p } });
    expect(w.text()).toContain("記録 3015");
  });

  it("未対応の種別を一覧に出す（版数差が見えるように）", () => {
    const w = mount(PlanViewer, { props: { plan: plan({ unknownRecordTypes: [3006, 3015] }) } });
    expect(w.text()).toContain(MSG_PLAN_UNKNOWN_RECORDS);
    expect(w.text()).toContain("3006, 3015");
  });

  it("未対応が無ければその節を出さない（毎回出して信号を埋もれさせない）", () => {
    const w = mount(PlanViewer, { props: { plan: plan({ unknownRecordTypes: [] }) } });
    expect(w.text()).not.toContain(MSG_PLAN_UNKNOWN_RECORDS);
  });
});

describe("索引の助言", () => {
  it("CREATE INDEX 文を見せる", () => {
    const w = mount(PlanViewer, { props: { plan: plan({ advice: [advice] }) } });
    expect(w.text()).toContain(advice.createStatement);
  });

  it("**作成の入口が無ければボタンを出さない**（見せるだけ）", () => {
    const w = mount(PlanViewer, { props: { plan: plan({ advice: [advice] }) } });
    expect(w.findAll("button").some((b) => b.text().includes("この索引を作成"))).toBe(false);
  });

  it("確認で拒否したら作成しない（取り消せない操作）", async () => {
    const onCreateIndex = vi.fn(async () => undefined);
    vi.stubGlobal("confirm", () => false);
    const w = mount(PlanViewer, { props: { plan: plan({ advice: [advice] }), onCreateIndex } });
    await w.findAll("button").find((b) => b.text().includes("この索引を作成"))!.trigger("click");
    expect(onCreateIndex).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("確認したら作成する", async () => {
    const onCreateIndex = vi.fn(async () => undefined);
    vi.stubGlobal("confirm", () => true);
    const w = mount(PlanViewer, { props: { plan: plan({ advice: [advice] }), onCreateIndex } });
    await w.findAll("button").find((b) => b.text().includes("この索引を作成"))!.trigger("click");
    expect(onCreateIndex).toHaveBeenCalledWith(advice);
    vi.unstubAllGlobals();
  });

  it("作成が失敗したら理由を出す（黙って終わらない）", async () => {
    const onCreateIndex = vi.fn(async () => {
      throw new Error("SQLCODE=-204");
    });
    vi.stubGlobal("confirm", () => true);
    const w = mount(PlanViewer, { props: { plan: plan({ advice: [advice] }), onCreateIndex } });
    await w.findAll("button").find((b) => b.text().includes("この索引を作成"))!.trigger("click");
    await new Promise((r) => setTimeout(r, 0));
    expect(w.text()).toContain("SQLCODE=-204");
    vi.unstubAllGlobals();
  });
});

describe("比較", () => {
  it("相手を渡すと差分表が出る", () => {
    const left = plan();
    const right = plan({
      summary: { ...plan().summary, nodeCount: 5, indexes: [] }
    });
    const w = mount(PlanViewer, { props: { plan: left, compareWith: right } });
    expect(w.text()).toContain("比較");
    expect(w.find(".pv-table").exists()).toBe(true);
    expect(w.findAll(".pv-table tr.changed").length).toBeGreaterThan(0);
  });

  it("相手が無ければ比較を出さない", () => {
    const w = mount(PlanViewer, { props: { plan: plan() } });
    expect(w.find(".pv-table").exists()).toBe(false);
  });
});

describe("採取モードの表示", () => {
  it("**「実行しない」とは書かない**（no-rows でも文はホストで実行される）", () => {
    const w = mount(PlanViewer, { props: { plan: plan({ captured: "no-rows" }) } });
    expect(w.text()).toContain("行を返さず計画");
    expect(w.text()).not.toContain("実行しない");
  });

  it("プランキャッシュ由来と分かる", () => {
    const w = mount(PlanViewer, { props: { plan: plan({ captured: "plan-cache" }) } });
    expect(w.text()).toContain("プランキャッシュ");
  });
});
