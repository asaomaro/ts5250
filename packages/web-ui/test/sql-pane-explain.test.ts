import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import SqlPane from "../src/components/SqlPane.vue";
import { systemsStore } from "../src/stores/systems.js";
import { planStore } from "../src/planStore.js";
import {
  MSG_PLAN_MODE_RUN,
  MSG_PLAN_MODE_NO_ROWS,
  MSG_PLAN_MODE_NO_ROWS_HINT
} from "../src/composables/opMessages.js";

/**
 * SQL ペインからの実行計画の導線。
 *
 * 見たいのは:
 * - 2 つのモードのボタンが出る
 * - **`no-rows` を「実行しない」と書かない**（IBM i にその経路は無い。research F7）
 * - **こちらの推測でボタンを塞がない**（`docs/UI-DESIGN.md`「検出結果で選択肢を塞がない」）
 * - 計画は結果表を置き換えず、別パネルに出る
 */
const originalFetch = globalThis.fetch;
const SYSTEM = { ref: "own:s1", name: "自分のシステム", host: "h", autoSignon: false };

function selectSystem(): void {
  systemsStore.systems = [SYSTEM];
  systemsStore.sessions = [];
  systemsStore.loaded = true;
  systemsStore.select(SYSTEM.ref);
}

const PLAN = {
  statement: "SELECT 1 FROM SYSIBM.SYSDUMMY1",
  captured: "run",
  at: "2026-08-02T00:00:00Z",
  blocks: [
    {
      number: 1,
      nodes: [
        {
          id: "1-0",
          kind: "table-scan",
          category: "step",
          recordType: 3000,
          label: "表の走査: SYSDUMMY1",
          attributes: [{ label: "記録種別", value: "3000" }]
        }
      ]
    }
  ],
  advice: [],
  summary: { nodeCount: 1, stepCount: 1, blockCount: 1, tables: ["SYSIBM.SYSDUMMY1"], indexes: [], adviceCount: 0 },
  unknownRecordTypes: []
};

/** explain の要求を捕まえる偽 fetch */
function mockExplain(body: unknown, ok = true): { calls: { url: string; body: Record<string, unknown> }[] } {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
    const target = String(url);
    if (init?.body) calls.push({ url: target, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    if (target === "/api/host/sql/explain") {
      return { ok, status: ok ? 200 : 400, json: async () => body } as Response;
    }
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  }) as typeof fetch;
  return { calls };
}

beforeEach(() => {
  selectSystem();
  planStore.history.splice(0, planStore.history.length);
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  systemsStore.systems = [];
  systemsStore.loaded = false;
  vi.restoreAllMocks();
});

function planButton(w: ReturnType<typeof mount>, label: string) {
  return w.findAll("header button").find((b) => b.text() === label);
}

describe("導線のボタン", () => {
  it("2 つのモードのボタンが出る", async () => {
    mockExplain({ plan: PLAN });
    const w = mount(SqlPane, { props: { tabId: "sql:query", system: SYSTEM.ref } });
    await w.find("textarea").setValue("SELECT 1 FROM SYSIBM.SYSDUMMY1");
    expect(planButton(w, MSG_PLAN_MODE_RUN)).toBeDefined();
    expect(planButton(w, MSG_PLAN_MODE_NO_ROWS)).toBeDefined();
    w.unmount();
  });

  it("**「実行しない」とは書かない**（文はホストで実行される）", async () => {
    mockExplain({ plan: PLAN });
    const w = mount(SqlPane, { props: { tabId: "sql:query", system: SYSTEM.ref } });
    await w.find("textarea").setValue("SELECT 1");
    const btn = planButton(w, MSG_PLAN_MODE_NO_ROWS)!;
    expect(btn.attributes("title")).toBe(MSG_PLAN_MODE_NO_ROWS_HINT);
    expect(btn.attributes("title")).toContain("文はホストで実行されます");
    expect(w.text()).not.toContain("実行しない");
    w.unmount();
  });

  it("**更新系でもボタンを塞がない**（サーバーの拒否で分からせる）", async () => {
    mockExplain({ plan: PLAN });
    const w = mount(SqlPane, { props: { tabId: "sql:query", system: SYSTEM.ref } });
    await w.find("textarea").setValue("DELETE FROM QTEMP.T");
    expect(planButton(w, MSG_PLAN_MODE_NO_ROWS)).toBeDefined();
    w.unmount();
  });

  it("SQL が空なら押せない", async () => {
    mockExplain({ plan: PLAN });
    const w = mount(SqlPane, { props: { tabId: "sql:query", system: SYSTEM.ref } });
    expect(planButton(w, MSG_PLAN_MODE_RUN)!.attributes("disabled")).toBeDefined();
    w.unmount();
  });
});

describe("計画の取得", () => {
  it("モードをサーバーへ渡す", async () => {
    const { calls } = mockExplain({ plan: PLAN });
    const w = mount(SqlPane, { props: { tabId: "sql:query", system: SYSTEM.ref } });
    await w.find("textarea").setValue("SELECT 1 FROM SYSIBM.SYSDUMMY1");
    await planButton(w, MSG_PLAN_MODE_NO_ROWS)!.trigger("click");
    await flushPromises();

    const call = calls.find((c) => c.url === "/api/host/sql/explain");
    expect(call?.body["mode"]).toBe("no-rows");
    expect(call?.body["sql"]).toBe("SELECT 1 FROM SYSIBM.SYSDUMMY1");
    w.unmount();
  });

  it("**source はオブジェクトで送る**（文字列だとサーバーが 400 を返す）", async () => {
    // 実ブラウザ検証で `Invalid input: expected object, received string` を踏んだ。
    // 偽 fetch は body を捕まえていたのに**形を検証していなかった**ので気づけなかった
    const { calls } = mockExplain({ plan: PLAN });
    const w = mount(SqlPane, { props: { tabId: "sql:query", system: SYSTEM.ref } });
    await w.find("textarea").setValue("SELECT 1");
    await planButton(w, MSG_PLAN_MODE_RUN)!.trigger("click");
    await flushPromises();

    const call = calls.find((c) => c.url === "/api/host/sql/explain");
    expect(call?.body["source"]).toEqual({ system: SYSTEM.ref });
    w.unmount();
  });

  it("**複数文なら先頭の 1 文だけ**を対象にする（どれの計画か曖昧にしない）", async () => {
    const { calls } = mockExplain({ plan: PLAN });
    const w = mount(SqlPane, { props: { tabId: "sql:query", system: SYSTEM.ref } });
    await w.find("textarea").setValue("SELECT 1 FROM A;\nSELECT 2 FROM B;");
    await planButton(w, MSG_PLAN_MODE_RUN)!.trigger("click");
    await flushPromises();

    expect(String(calls.find((c) => c.url === "/api/host/sql/explain")?.body["sql"])).toContain("FROM A");
    expect(String(calls.find((c) => c.url === "/api/host/sql/explain")?.body["sql"])).not.toContain("FROM B");
    w.unmount();
  });

  it("計画が別パネルに出る（結果表を置き換えない）", async () => {
    mockExplain({ plan: PLAN });
    const w = mount(SqlPane, { props: { tabId: "sql:query", system: SYSTEM.ref } });
    await w.find("textarea").setValue("SELECT 1 FROM SYSIBM.SYSDUMMY1");
    await planButton(w, MSG_PLAN_MODE_RUN)!.trigger("click");
    await flushPromises();

    expect(w.find(".plan-panel").exists()).toBe(true);
    expect(w.text()).toContain("表の走査: SYSDUMMY1");
    // 結果領域は残っている
    expect(w.find(".results").exists()).toBe(true);
    w.unmount();
  });

  it("履歴に積まれる", async () => {
    mockExplain({ plan: PLAN });
    const w = mount(SqlPane, { props: { tabId: "sql:query", system: SYSTEM.ref } });
    await w.find("textarea").setValue("SELECT 1");
    await planButton(w, MSG_PLAN_MODE_RUN)!.trigger("click");
    await flushPromises();

    expect(planStore.history).toHaveLength(1);
    w.unmount();
  });

  it("失敗したら理由を出す（黙って終わらない）", async () => {
    mockExplain({ error: "行を返さずに計画だけ取るモードは SELECT 系の文でのみ使えます" }, false);
    const w = mount(SqlPane, { props: { tabId: "sql:query", system: SYSTEM.ref } });
    await w.find("textarea").setValue("DELETE FROM QTEMP.T");
    await planButton(w, MSG_PLAN_MODE_NO_ROWS)!.trigger("click");
    await flushPromises();

    expect(w.text()).toContain("SELECT 系の文でのみ使えます");
    w.unmount();
  });

  it("**警告を握り潰さない**（モニターが残った可能性など）", async () => {
    mockExplain({ plan: PLAN, warnings: ["モニターの停止に失敗しました"] });
    const w = mount(SqlPane, { props: { tabId: "sql:query", system: SYSTEM.ref } });
    await w.find("textarea").setValue("SELECT 1");
    await planButton(w, MSG_PLAN_MODE_RUN)!.trigger("click");
    await flushPromises();

    expect(w.text()).toContain("モニターの停止に失敗しました");
    w.unmount();
  });
});
