import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import SqlPane from "../src/components/SqlPane.vue";
import { systemsStore } from "../src/stores/systems.js";

/**
 * 結果を返さない文（DML / DDL）の表示。
 *
 * 見たいのは 3 つ:
 * - **行数に意味がある文は件数**、意味が無い文（DDL）は**完了だけ**
 *   ——DDL に「0 行に影響しました」と出すと、消えたのか作られたのか分からない
 * - **警告（SQLCODE > 0）を落とさない**（表は作られたのに何も言われないのを防ぐ）
 * - **「該当する行はありません」を出さない**（行が 0 件の SELECT と混ぜない）
 */
const originalFetch = globalThis.fetch;
const SYSTEM = { ref: "own:s1", name: "自分のシステム", host: "h", autoSignon: false };

function selectSystem(): void {
  systemsStore.systems = [SYSTEM];
  systemsStore.sessions = [];
  systemsStore.loaded = true;
  systemsStore.select(SYSTEM.ref);
}

/** 実行のたびに違う応答を返す偽 fetch */
function mockSequence(bodies: { status?: number; body: unknown }[]): { sent: string[] } {
  const sent: string[] = [];
  let n = 0;
  globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
    const target = String(url);
    if (target === "/api/host/sql" && init?.body) {
      const sql = JSON.parse(String(init.body)).sql as string;
      // **補完の問い合わせは順番を食わない。** `FROM QTEMP.` まで打った時点で
      // 列・表の候補を引きに行くので、素通しさせないと本題の応答がずれる
      if (/QSYS2\.SYS(TABLES|COLUMNS)/u.test(sql)) {
        return { ok: true, status: 200, json: async () => ({ rows: [] }) } as Response;
      }
      sent.push(sql);
      const entry = bodies[n++] ?? { body: {} };
      return {
        ok: entry.status === undefined,
        status: entry.status ?? 200,
        json: async () => entry.body
      } as Response;
    }
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  }) as typeof fetch;
  return { sent };
}

/** サーバーの非クエリ応答 */
const executed = (updateCount: number, hasRowCount: boolean, warning?: unknown) => ({
  kind: "execute",
  updateCount,
  hasRowCount,
  ...(warning ? { warning } : {})
});
/** クエリ応答（比較用） */
const rowsOf = (n: number) => ({
  columns: [{ name: "ID", typeName: "INTEGER", nullable: false }],
  rows: Array.from({ length: n }, (_, i) => ({ ID: i + 1 })),
  rowCount: n
});

beforeEach(selectSystem);
afterEach(() => {
  globalThis.fetch = originalFetch;
  systemsStore.systems = [];
  systemsStore.loaded = false;
  vi.restoreAllMocks();
});

async function run(sql: string) {
  const w = mount(SqlPane, { props: { tabId: "sql:query", system: SYSTEM.ref } });
  await w.find("textarea").setValue(sql);
  await w.find("header button").trigger("click");
  await flushPromises();
  return w;
}

describe("非クエリ文の結果表示", () => {
  it("DML は影響行数を出す", async () => {
    mockSequence([{ body: executed(3, true) }]);
    const w = await run("DELETE FROM QTEMP.T WHERE ID > 0");
    expect(w.find(".done").text()).toContain("3 行に影響しました");
    w.unmount();
  });

  it("DDL は「実行しました」だけ（0 行と書かない）", async () => {
    mockSequence([{ body: executed(0, false) }]);
    const w = await run("CREATE TABLE QTEMP.T (ID INT)");
    const text = w.find(".done").text();
    expect(text).toContain("実行しました");
    expect(text).not.toContain("0 行");
    w.unmount();
  });

  it("0 行に影響した DML は「0 行に影響しました」（DDL と区別する）", async () => {
    mockSequence([{ body: executed(0, true) }]);
    const w = await run("DELETE FROM QTEMP.T WHERE 1 = 0");
    expect(w.find(".done").text()).toContain("0 行に影響しました");
    w.unmount();
  });

  it("警告つき成功は SQLCODE / SQLSTATE を添える", async () => {
    mockSequence([{ body: executed(0, false, { sqlCode: 7905, sqlState: "01567" }) }]);
    const w = await run("CREATE TABLE ASAOLIB.T (ID INT)");
    const text = w.find(".done").text();
    expect(text).toContain("実行しました");
    expect(text).toContain("SQLCODE=7905");
    expect(text).toContain("SQLSTATE=01567");
    w.unmount();
  });

  it("「該当する行はありません」は出さない（行が無いのは当たり前）", async () => {
    mockSequence([{ body: executed(1, true) }]);
    const w = await run("INSERT INTO QTEMP.T VALUES(1)");
    expect(w.text()).not.toContain("該当する行はありません");
    w.unmount();
  });

  it("CSV のダウンロードは出さない（行が無いので落とすものが無い）", async () => {
    mockSequence([{ body: executed(1, true) }]);
    const w = await run("INSERT INTO QTEMP.T VALUES(1)");
    expect(w.text()).not.toContain("CSV をダウンロード");
    w.unmount();
  });

  it("失敗は既存のエラー表示のまま（SQLCODE を添える）", async () => {
    mockSequence([
      { status: 400, body: { error: "文を準備できませんでした", sqlCode: -204, sqlState: "42704" } }
    ]);
    const w = await run("DELETE FROM QTEMP.NOSUCH");
    expect(w.find(".error").text()).toContain("文を準備できませんでした");
    expect(w.find(".error").text()).toContain("SQLCODE=-204");
    expect(w.find(".done").exists()).toBe(false);
    w.unmount();
  });
});

describe("クエリと混ぜたとき", () => {
  it("結果を返す文はこれまでどおり表を出す（実行結果の表示は出さない）", async () => {
    mockSequence([{ body: rowsOf(2) }]);
    const w = await run("SELECT ID FROM QTEMP.T");
    expect(w.find(".done").exists()).toBe(false);
    expect(w.findAll("tbody tr").length).toBeGreaterThan(0);
    w.unmount();
  });

  it("`;` 区切りで混在させると、タブごとに表と実行結果が切り替わる", async () => {
    mockSequence([{ body: executed(2, true) }, { body: rowsOf(1) }]);
    const w = await run("UPDATE QTEMP.T SET S = 'z'; SELECT ID FROM QTEMP.T");

    const tabs = w.findAll(".rtab");
    expect(tabs).toHaveLength(2);
    // 1 番目（非クエリ）が選ばれている
    expect(w.find(".done").text()).toContain("2 行に影響しました");
    // 影響行数はタブの見出しにも出る
    expect(tabs[0]!.text()).toContain("2");

    await tabs[1]!.trigger("click");
    await flushPromises();
    expect(w.find(".done").exists()).toBe(false);
    expect(w.findAll("tbody tr").length).toBeGreaterThan(0);
    w.unmount();
  });

  it("行数の意味が無い文のタブは「済」（0 と出さない）", async () => {
    mockSequence([{ body: executed(0, false) }, { body: rowsOf(1) }]);
    const w = await run("DROP TABLE QTEMP.T; SELECT ID FROM QTEMP.T2");
    expect(w.findAll(".rtab")[0]!.text()).toContain("済");
    w.unmount();
  });
});

/**
 * **`CALL P(…, ?)` の出力パラメーター。** 手続きの結果はこれしか無いので、
 * 出さないと呼んだ意味が分からない（SR-OSAKA で実機確認した経路）。
 */
describe("CALL の出力パラメーター", () => {
  it("? の並びと値を表に出す", async () => {
    mockSequence([{ body: { kind: "execute", updateCount: 0, hasRowCount: false, outputs: ["19.25", null] } }]);
    const w = await run("CALL ASAOLIB.P(1, ?, ?)");
    const cells = w.findAll(".outparams tbody td").map((c) => c.text());
    expect(cells).toEqual(["?1", "19.25", "?2", "NULL"]);
    w.unmount();
  });

  it("出力が無ければ表は出ない（DDL・DML の見え方を変えない）", async () => {
    mockSequence([{ body: executed(1, true) }]);
    const w = await run("DELETE FROM QTEMP.T WHERE ID = 1");
    expect(w.find(".outparams").exists()).toBe(false);
    w.unmount();
  });
});

/**
 * **手続きが返した結果セット**（`CALL` → `SQLCODE +466`）。
 * 表に出せるのは 1 個目だけなので、2 個以上あることは必ず文章で言う
 * ——黙って 1 個目だけ出すと「全部見た」と思わせてしまう。
 */
describe("CALL の結果セット", () => {
  const withResultSet = (rows: number, extra: Record<string, unknown> = {}) => ({
    kind: "execute",
    updateCount: 0,
    hasRowCount: false,
    columns: [{ name: "ID", typeName: "INTEGER", nullable: false }],
    rows: Array.from({ length: rows }, (_, i) => ({ ID: i + 1 })),
    rowCount: rows,
    resultSets: 1,
    ...extra
  });

  it("結果セットを表で出し、結果セットがあることを言う", async () => {
    mockSequence([{ body: withResultSet(3) }]);
    const w = await run("CALL ASAOLIB.P()");
    expect(w.find(".done").text()).toContain("結果セットを表示しています");
    expect(w.findAll("tbody tr").length).toBe(3);
    w.unmount();
  });

  /**
   * **取れないことまで言う。** 「1 個目を表示」だけだと、2 個目を出す操作を
   * 画面の中で探させてしまう（ホストがこの経路に 1 個目しか出さない）。
   */
  it("2 個以上あるときは**何個あって何個目か**と、残りが取れないことを言う", async () => {
    mockSequence([{ body: withResultSet(3, { resultSets: 2 }) }]);
    const w = await run("CALL ASAOLIB.P()");
    const text = w.find(".done").text();
    expect(text).toContain("結果セット 2 個のうち 1 個目");
    expect(text).toContain("取得できません");
    w.unmount();
  });

  it("上限で切ったことを言う（続きは取りに行けない）", async () => {
    mockSequence([{ body: withResultSet(2, { truncated: true }) }]);
    const w = await run("CALL ASAOLIB.P()");
    expect(w.find(".done").text()).toContain("先頭 2 件だけです");
    w.unmount();
  });

  it("結果セットの無い CALL は今までどおり（余計なことを言わない）", async () => {
    mockSequence([{ body: executed(0, false) }]);
    const w = await run("CALL ASAOLIB.P()");
    const text = w.find(".done").text();
    expect(text).toContain("実行しました");
    expect(text).not.toContain("結果セット");
    w.unmount();
  });
});
