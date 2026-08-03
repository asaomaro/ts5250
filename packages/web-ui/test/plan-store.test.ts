import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  planStore,
  pushHistory,
  savePlan,
  removeSaved,
  clearHistory,
  exportPlans,
  importPlans,
  diffPlans,
  defaultName,
  MAX_SAVED,
  MAX_HISTORY
} from "../src/planStore.js";
import type { PlanNode, QueryPlan } from "../src/planApi.js";

/**
 * 計画の履歴・保存・比較。
 *
 * サーバー側に保存領域を作らない方針（`spec.md`）なので、**溜め込ませない歯止め**
 * （上限と「落としたことを返す」）をここで固定する。
 */
const node = (over: Partial<PlanNode> = {}): PlanNode => ({
  id: "1-0",
  kind: "table-scan",
  category: "step",
  recordType: 3000,
  label: "表アクセス: T",
  attributes: [],
  ...over
});

function plan(over: Partial<QueryPlan> = {}): QueryPlan {
  return {
    statement: "SELECT 1 FROM T",
    captured: "run",
    at: "2026-08-02T00:00:00Z",
    blocks: [{ number: 1, nodes: [node()] }],
    advice: [],
    summary: { nodeCount: 1, stepCount: 1, blockCount: 1, tables: ["S.T"], indexes: [], adviceCount: 0 },
    unknownRecordTypes: [],
    ...over
  };
}

beforeEach(() => {
  planStore.saved.splice(0, planStore.saved.length);
  planStore.history.splice(0, planStore.history.length);
  globalThis.localStorage?.clear();
});

describe("履歴", () => {
  it("新しいものが先頭に積まれる", () => {
    pushHistory(plan({ statement: "A" }));
    pushHistory(plan({ statement: "B" }));
    expect(planStore.history.map((p) => p.plan.statement)).toEqual(["B", "A"]);
  });

  it("上限を超えたら古い順に落とし、**落とした件数を返す**", () => {
    for (let i = 0; i < MAX_HISTORY; i++) pushHistory(plan({ statement: `S${i}` }));
    expect(pushHistory(plan({ statement: "NEW" })).dropped).toBe(1);
    expect(planStore.history).toHaveLength(MAX_HISTORY);
    expect(planStore.history[0]?.plan.statement).toBe("NEW");
  });

  it("上限内なら何も落とさない", () => {
    expect(pushHistory(plan()).dropped).toBe(0);
  });

  it("消せる", () => {
    pushHistory(plan());
    clearHistory();
    expect(planStore.history).toEqual([]);
  });
});

describe("保存", () => {
  it("名前を付けられる。既定は文の先頭", () => {
    const { entry } = savePlan(plan({ statement: "SELECT X FROM Y" }));
    expect(entry.name).toBe("SELECT X FROM Y");
    const named = savePlan(plan(), "チューニング前");
    expect(named.entry.name).toBe("チューニング前");
  });

  it("長い文は既定名を切り詰める", () => {
    const long = `SELECT ${"A".repeat(200)}`;
    expect(defaultName(plan({ statement: long })).length).toBeLessThanOrEqual(61);
    expect(defaultName(plan({ statement: long })).endsWith("…")).toBe(true);
  });

  it("空白だけの名前は既定に落とす（名前なしの行を作らない）", () => {
    const { entry } = savePlan(plan({ statement: "SELECT 1" }), "   ");
    expect(entry.name).toBe("SELECT 1");
  });

  it("上限を超えたら落とし、件数を返す", () => {
    for (let i = 0; i < MAX_SAVED; i++) savePlan(plan({ statement: `S${i}` }));
    expect(savePlan(plan()).dropped).toBe(1);
    expect(planStore.saved).toHaveLength(MAX_SAVED);
  });

  it("削除できる", () => {
    const { entry } = savePlan(plan());
    removeSaved(entry.id);
    expect(planStore.saved).toEqual([]);
  });
});

describe("JSON の入出力", () => {
  it("書き出して読み込むと戻る", () => {
    savePlan(plan({ statement: "SELECT Z" }), "保存 1");
    const text = exportPlans(planStore.saved);
    planStore.saved.splice(0, planStore.saved.length);

    const added = importPlans(text);
    expect(added).toHaveLength(1);
    expect(planStore.saved[0]?.plan.statement).toBe("SELECT Z");
    expect(planStore.saved[0]?.name).toBe("保存 1");
  });

  it("**形の違う JSON は受け付けない**（黙って空を足さない）", () => {
    expect(() => importPlans("{}")).toThrow(/実行計画の書き出しではありません/u);
    expect(() => importPlans('{"kind":"ts5250.plan","version":9,"plans":[]}')).toThrow(/対応していない版/u);
    expect(() => importPlans('{"kind":"ts5250.plan","version":1}')).toThrow(/plans がありません/u);
  });

  it("JSON として壊れていれば理由を出す", () => {
    expect(() => importPlans("これは JSON ではない")).toThrow(/JSON として読めません/u);
  });

  it("中身が 1 件も無ければ理由を出す（「読み込んだのに何も出ない」を作らない）", () => {
    expect(() => importPlans('{"kind":"ts5250.plan","version":1,"plans":[{"name":"x"}]}')).toThrow(
      /読み込める計画がありませんでした/u
    );
  });
});

describe("比較", () => {
  it("要約の差を出し、変わった項目に印を付ける", () => {
    const a = plan({ summary: { nodeCount: 3, stepCount: 3, blockCount: 1, tables: ["S.T"], indexes: [], adviceCount: 1 } });
    const b = plan({ summary: { nodeCount: 3, stepCount: 3, blockCount: 1, tables: ["S.T"], indexes: ["IX"], adviceCount: 0 } });
    const d = diffPlans(a, b);

    expect(d.summary.find((r) => r.label === "ノード数")?.changed).toBe(false);
    expect(d.summary.find((r) => r.label === "索引")?.changed).toBe(true);
    expect(d.summary.find((r) => r.label === "索引の助言")?.changed).toBe(true);
  });

  it("**ノードは (種別, 表, 索引) で対応付ける**（並び順に依存しない）", () => {
    const left = plan({
      blocks: [{ number: 1, nodes: [node({ id: "1-0", table: { schema: "S", name: "T" }, estimatedRows: 100 })] }]
    });
    // 前に別のノードが増えても、同じノードは「同じ」と判定されること
    const right = plan({
      blocks: [
        {
          number: 1,
          nodes: [
            node({ id: "1-0", kind: "other", category: "info", recordType: 3006, label: "記録 3006" }),
            node({ id: "1-1", table: { schema: "S", name: "T" }, estimatedRows: 100 })
          ]
        }
      ]
    });
    const d = diffPlans(left, right);
    const same = d.nodes.find((n) => n.state === "same");
    expect(same).toBeDefined();
    expect(d.nodes.some((n) => n.state === "right-only")).toBe(true);
  });

  it("推定行数が変われば changed", () => {
    const left = plan({ blocks: [{ number: 1, nodes: [node({ estimatedRows: 100 })] }] });
    const right = plan({ blocks: [{ number: 1, nodes: [node({ estimatedRows: 5 })] }] });
    expect(diffPlans(left, right).nodes[0]?.state).toBe("changed");
  });

  it("片方にしか無いノードを示す", () => {
    const left = plan({ blocks: [{ number: 1, nodes: [node({ index: { name: "IX1" } })] }] });
    const right = plan({ blocks: [{ number: 1, nodes: [] }] });
    expect(diffPlans(left, right).nodes[0]?.state).toBe("left-only");
  });
});

describe("localStorage に書けないとき", () => {
  it("**書けなかったことを返す**（「保存しました」で終わらせない）", () => {
    // jsdom の Storage はインスタンスへの代入が効かないので prototype を差し替える
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    try {
      const r = savePlan(plan());
      expect(r.persisted).toBe(false);
      // **画面の操作は続けられる**（メモリ上には載っている）
      expect(planStore.saved).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("書けたときは persisted が true", () => {
    expect(savePlan(plan()).persisted).toBe(true);
    expect(pushHistory(plan()).persisted).toBe(true);
  });
});
