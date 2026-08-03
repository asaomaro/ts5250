import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import PlanListPane from "../src/components/PlanListPane.vue";
import { planStore, pushHistory } from "../src/planStore.js";
import { MSG_PLAN_CACHE_FALLBACK } from "../src/composables/opMessages.js";
import type { QueryPlan } from "../src/planApi.js";

/**
 * 計画一覧ペイン。
 *
 * 一番大事なのは **FR-9: 権限が無いときに黙って空にしない**こと。
 * 実測（research F15）で PUB400 の非特権ユーザーは `-443/38501` を受け取り、
 * サーバーはそれを `available:false` ＋ 理由に畳む。画面はそれを出して履歴へ逃がす。
 */
const REASON = "この接続では計画一覧を参照できません（システム全体の計画を見るには *JOBCTL 等の特権が要ります）";

function plan(statement = "SELECT 1"): QueryPlan {
  return {
    statement,
    captured: "run",
    at: "2026-08-02T00:00:00Z",
    blocks: [{ number: 1, nodes: [] }],
    advice: [],
    summary: { nodeCount: 0, stepCount: 0, blockCount: 1, tables: [], indexes: [], adviceCount: 0 },
    unknownRecordTypes: []
  };
}

function mockFetch(body: unknown, ok = true): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok, json: async () => body }) as unknown as Response)
  );
}

beforeEach(() => {
  planStore.saved.splice(0, planStore.saved.length);
  planStore.history.splice(0, planStore.history.length);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const props = { tabId: "plan:explain@own:a", active: true, system: "own:a" };

describe("権限が無いとき（FR-9）", () => {
  it("**理由を出す**（黙って空一覧にしない）", async () => {
    mockFetch({ available: false, reason: REASON, items: [] });
    const w = mount(PlanListPane, { props });
    await flushPromises();

    expect(w.text()).toContain(REASON);
    expect(w.text()).toContain("*JOBCTL");
  });

  it("履歴側へ逃がす案内とボタンを出す", async () => {
    mockFetch({ available: false, reason: REASON, items: [] });
    const w = mount(PlanListPane, { props });
    await flushPromises();

    expect(w.text()).toContain(MSG_PLAN_CACHE_FALLBACK);
    const btn = w.findAll("button").find((b) => b.text() === "実行履歴を見る");
    expect(btn).toBeDefined();
  });

  it("そのボタンで履歴に切り替わる", async () => {
    mockFetch({ available: false, reason: REASON, items: [] });
    pushHistory(plan("SELECT FROM HISTORY"));
    const w = mount(PlanListPane, { props });
    await flushPromises();

    await w.findAll("button").find((b) => b.text() === "実行履歴を見る")!.trigger("click");
    await flushPromises();
    expect(w.text()).toContain("SELECT FROM HISTORY");
    expect(w.text()).not.toContain(REASON);
  });
});

describe("参照できるとき", () => {
  it("一覧が出る", async () => {
    mockFetch({
      available: true,
      items: [{ id: "1", statement: "SELECT A FROM T", tables: ["S.T"], recordCount: 9 }]
    });
    const w = mount(PlanListPane, { props });
    await flushPromises();

    expect(w.text()).toContain("SELECT A FROM T");
    expect(w.text()).toContain("記録 9 件");
  });

  it("0 件なら「計画がありません」（権限の話にしない）", async () => {
    mockFetch({ available: true, items: [] });
    const w = mount(PlanListPane, { props });
    await flushPromises();

    expect(w.text()).toContain("計画がありません");
    expect(w.text()).not.toContain("*JOBCTL");
  });
});

describe("ソースの切替", () => {
  it("履歴と保存済みの件数がボタンに出る", async () => {
    mockFetch({ available: true, items: [] });
    pushHistory(plan("A"));
    pushHistory(plan("B"));
    const w = mount(PlanListPane, { props });
    await flushPromises();

    expect(w.findAll("button").some((b) => b.text().includes("実行履歴（2）"))).toBe(true);
    expect(w.findAll("button").some((b) => b.text().includes("保存済み（0）"))).toBe(true);
  });

  it("履歴の計画を選ぶとビューアに出る", async () => {
    mockFetch({ available: true, items: [] });
    pushHistory(plan("SELECT PICKED"));
    const w = mount(PlanListPane, { props });
    await flushPromises();

    await w.findAll("button").find((b) => b.text().includes("実行履歴"))!.trigger("click");
    await flushPromises();
    await w.find(".pl-item").trigger("click");
    await flushPromises();

    // ビューアが出ている（採取モードの行が出る）
    expect(w.text()).toContain("実行して計画");
  });
});

describe("取得の失敗", () => {
  it("エラーを画面に出す", async () => {
    mockFetch({ error: "ホストへ接続できません" }, false);
    const w = mount(PlanListPane, { props });
    await flushPromises();

    expect(w.text()).toContain("ホストへ接続できません");
  });
});
