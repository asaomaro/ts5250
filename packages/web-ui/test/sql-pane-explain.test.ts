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
 * - 計画は**結果と同じ帯のタブ**に出る（置き換えない・閉じられる・クエリごとに持つ）
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

/** 実行（行あり）と explain の両方に応える偽 fetch。タブの行き来を見るのに使う */
function mockRunAndExplain(planBody: unknown = { plan: PLAN }): void {
  globalThis.fetch = vi.fn(async (url: unknown) => {
    const target = String(url);
    if (target === "/api/host/sql/explain") {
      return { ok: true, status: 200, json: async () => planBody } as Response;
    }
    if (target === "/api/host/sql") {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          columns: [{ name: "A", typeName: "INTEGER", nullable: false }],
          rows: [{ A: 1 }, { A: 2 }],
          rowCount: 2
        })
      } as Response;
    }
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  }) as typeof fetch;
}

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

  it("計画が結果と同じ帯のタブに出る", async () => {
    mockExplain({ plan: PLAN });
    const w = mount(SqlPane, { props: { tabId: "sql:query", system: SYSTEM.ref } });
    await w.find("textarea").setValue("SELECT 1 FROM SYSIBM.SYSDUMMY1");
    await planButton(w, MSG_PLAN_MODE_RUN)!.trigger("click");
    await flushPromises();

    // 帯に「実行計画」タブが出て、選ばれている
    const tab = w.find(".rtab.plan");
    expect(tab.exists()).toBe(true);
    expect(tab.text()).toContain("実行計画");
    expect(tab.classes()).toContain("sel");
    // 中身は結果領域の中（＝結果表と同じ枠。挟み込みのパネルではない）
    expect(w.find(".results .plan-view").exists()).toBe(true);
    expect(w.text()).toContain("表の走査: SYSDUMMY1");
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

  it("計画のタブは 1 本でも帯を出す（切り替えと閉じるの手立てがそこにしか無い）", async () => {
    mockExplain({ plan: PLAN });
    const w = mount(SqlPane, { props: { tabId: "sql:query", system: SYSTEM.ref } });
    await w.find("textarea").setValue("SELECT 1");
    await planButton(w, MSG_PLAN_MODE_RUN)!.trigger("click");
    await flushPromises();

    expect(w.find(".rtabs").exists()).toBe(true);
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

/**
 * タブにしたことで増える約束。**結果を置き換えない**（別パネルにしていた理由）を
 * タブでも満たしているかを、行き来と再実行で確かめる。
 */
describe("結果タブとの行き来", () => {
  async function runThenExplain() {
    mockRunAndExplain();
    const w = mount(SqlPane, { props: { tabId: "sql:query", system: SYSTEM.ref } });
    await w.find("textarea").setValue("SELECT A FROM T");
    await w.find("header button").trigger("click"); // 実行
    await flushPromises();
    await planButton(w, MSG_PLAN_MODE_RUN)!.trigger("click");
    await flushPromises();
    return w;
  }

  it("計画を見たあと結果へ戻れる（結果は消えていない）", async () => {
    const w = await runThenExplain();
    expect(w.find(".plan-view").exists()).toBe(true);
    expect(w.find("tbody").exists()).toBe(false);

    // 結果タブ（計画タブではない方）へ戻す
    const result = w.findAll(".rtab").find((t) => !t.classes().includes("plan"))!;
    await result.trigger("click");
    await flushPromises();

    expect(w.find(".plan-view").exists()).toBe(false);
    expect(w.findAll("tbody tr")).toHaveLength(2);
    w.unmount();
  });

  it("閉じるとタブごと消える（帯だけ残さない）", async () => {
    const w = await runThenExplain();
    await w.find(".rtab-x").trigger("click");
    await flushPromises();

    expect(w.find(".rtab.plan").exists()).toBe(false);
    expect(w.find(".plan-view").exists()).toBe(false);
    // 結果へ戻っている
    expect(w.findAll("tbody tr")).toHaveLength(2);
    w.unmount();
  });

  it("再実行すると結果へ焦点が戻る（計画タブは残す）", async () => {
    const w = await runThenExplain();
    await w.find("header button").trigger("click"); // もう一度「実行」
    await flushPromises();

    // 古い計画を見たまま新しい結果が隠れない
    expect(w.find(".plan-view").exists()).toBe(false);
    expect(w.findAll("tbody tr")).toHaveLength(2);
    // タブ自体は残っているので、計画へ戻れる
    expect(w.find(".rtab.plan").exists()).toBe(true);
    w.unmount();
  });

  /**
   * 計画は**クエリごと**に持つ。共有していると、別のクエリへ切り替えても
   * 前の計画がタブに残り、どの文の計画か分からなくなる
   */
  it("クエリを切り替えると計画も一緒に切り替わる", async () => {
    const w = await runThenExplain();
    expect(w.find(".rtab.plan").exists()).toBe(true);

    await w.find(".qadd").trigger("click"); // 新しいクエリへ
    await flushPromises();
    expect(w.find(".rtab.plan").exists()).toBe(false);

    await w.findAll(".qitem")[0]!.trigger("click"); // 元のクエリへ戻る
    await flushPromises();
    expect(w.find(".rtab.plan").exists()).toBe(true);
    expect(w.find(".plan-view").exists()).toBe(true);
    w.unmount();
  });
});
