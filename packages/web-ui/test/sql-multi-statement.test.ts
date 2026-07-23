import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import SqlPane from "../src/components/SqlPane.vue";
import { systemsStore } from "../src/stores/systems.js";

/**
 * `;` 区切りの複数文と結果タブ。
 *
 * 見たいのは 4 つ:
 * - **書いた順に 1 文ずつ投げる**（まとめて送らない）
 * - 結果ごとにタブが増え、切り替えると中身が変わる
 * - **単一文ではタブ帯を出さない**（今までの見え方を変えない）
 * - 途中で失敗したら**そこで止め**、それまでのタブは残す
 */
const originalFetch = globalThis.fetch;
const SYSTEM = { ref: "own:s1", name: "自分のシステム", host: "h", autoSignon: false };

function selectSystem(): void {
  systemsStore.systems = [SYSTEM];
  systemsStore.sessions = [];
  systemsStore.loaded = true;
  systemsStore.select(SYSTEM.ref);
}

/** 実行のたびに違う応答を返す偽 fetch。送った SQL を記録する */
function mockSequence(bodies: { status?: number; body: unknown }[]): { sent: string[] } {
  const sent: string[] = [];
  let n = 0;
  globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
    const target = String(url);
    if (target === "/api/host/sql" && init?.body) {
      sent.push(JSON.parse(String(init.body)).sql as string);
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

const result = (name: string, rowCount: number) => ({
  columns: [{ name, typeName: "INTEGER", nullable: false }],
  rows: Array.from({ length: rowCount }, (_, i) => ({ [name]: i + 1 })),
  rowCount
});

beforeEach(selectSystem);
afterEach(() => {
  globalThis.fetch = originalFetch;
  systemsStore.systems = [];
  systemsStore.loaded = false;
  vi.restoreAllMocks();
});

async function run(sql: string) {
  const w = mount(SqlPane, { props: { tabId: "sql:query" } });
  await w.find("textarea").setValue(sql);
  await w.find("header button").trigger("click");
  await flushPromises();
  return w;
}

describe("複数文の実行", () => {
  it("`;` で分けて書いた順に 1 文ずつ投げる", async () => {
    const { sent } = mockSequence([{ body: result("A", 2) }, { body: result("B", 3) }]);
    const w = await run("SELECT A FROM T1; SELECT B FROM T2");
    expect(sent).toEqual(["SELECT A FROM T1", "SELECT B FROM T2"]);
    w.unmount();
  });

  it("結果ごとにタブが出て、切り替えると中身が変わる", async () => {
    mockSequence([{ body: result("A", 2) }, { body: result("B", 3) }]);
    const w = await run("SELECT A FROM T1; SELECT B FROM T2");

    const tabs = w.findAll(".rtab");
    expect(tabs).toHaveLength(2);
    // 見出しに順番と文の要約が出る
    expect(tabs[0]?.text()).toContain("SELECT A FROM T1");
    expect(tabs[1]?.text()).toContain("SELECT B FROM T2");
    // **最初のタブが選ばれている**（書いた順に見るのが自然）
    expect(tabs[0]?.classes()).toContain("sel");
    expect(w.find("thead").text()).toContain("A");

    await tabs[1]?.trigger("click");
    await flushPromises();
    expect(w.find("thead").text()).toContain("B");
    expect(w.findAll("tbody tr")).toHaveLength(3);
    w.unmount();
  });

  /** 単一文の見え方を変えない（今まで無かった段を増やさない） */
  it("1 文だけならタブ帯を出さない", async () => {
    mockSequence([{ body: result("A", 2) }]);
    const w = await run("SELECT A FROM T1");
    expect(w.find(".rtabs").exists()).toBe(false);
    expect(w.findAll("tbody tr")).toHaveLength(2);
    w.unmount();
  });

  it("末尾の `;` や空の区切りで空のタブを作らない", async () => {
    const { sent } = mockSequence([{ body: result("A", 1) }]);
    const w = await run("SELECT A FROM T1;;  ");
    expect(sent).toEqual(["SELECT A FROM T1"]);
    expect(w.find(".rtabs").exists()).toBe(false);
    w.unmount();
  });

  it("文字列の中の `;` では分けない", async () => {
    const { sent } = mockSequence([{ body: result("A", 1) }]);
    const w = await run("SELECT A FROM T WHERE N = 'a;b'");
    expect(sent).toEqual(["SELECT A FROM T WHERE N = 'a;b'"]);
    w.unmount();
  });

  /** **失敗したら止める**。3 文目を投げないことと、1 文目のタブが残ることを見る */
  it("途中で失敗したら後続を実行せず、それまでのタブは残す", async () => {
    const { sent } = mockSequence([
      { body: result("A", 2) },
      { status: 400, body: { error: "prepare failed: SQLCODE=-204", sqlCode: -204, sqlState: "42704" } },
      { body: result("C", 1) }
    ]);
    const w = await run("SELECT A FROM T1; SELECT B FROM NOPE; SELECT C FROM T3");

    expect(sent).toEqual(["SELECT A FROM T1", "SELECT B FROM NOPE"]);
    // 何番目の文で失敗したかが分かる
    expect(w.find(".error").text()).toContain("2 番目の文");
    expect(w.find(".error").text()).toContain("SQLCODE=-204");
    // **1 文目の結果は残っている**（残った結果が 1 つだけなのでタブ帯は出ない）
    expect(w.findAll("tbody tr")).toHaveLength(2);
    expect(w.find("thead").text()).toContain("A");
    expect(w.find(".rtabs").exists()).toBe(false);
    w.unmount();
  });

  /** 単一文のときは「n 番目の文」を付けない（文言を変えない） */
  it("1 文だけの失敗では文番号を付けない", async () => {
    mockSequence([{ status: 400, body: { error: "prepare failed" } }]);
    const w = await run("SELECT A FROM NOPE");
    expect(w.find(".error").text()).toContain("prepare failed");
    expect(w.find(".error").text()).not.toContain("番目の文");
    w.unmount();
  });

  /** 複数タブを続けて落としたときに同じ名前で上書きさせない */
  it("CSV のファイル名に何番目の文かを付ける（複数タブのとき）", async () => {
    mockSequence([{ body: result("A", 1) }, { body: result("B", 1) }]);
    const w = await run("SELECT A FROM T1; SELECT B FROM T2");
    const clicks: string[] = [];
    const realCreate = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      const el = realCreate(tag) as HTMLAnchorElement;
      if (tag === "a") {
        el.click = () => clicks.push(el.download);
      }
      return el;
    });
    URL.createObjectURL = vi.fn(() => "blob:x");
    URL.revokeObjectURL = vi.fn();

    await w.findAll("header button").find((b) => b.text().includes("CSV"))?.trigger("click");
    expect(clicks[0]).toMatch(/-1\.csv$/);

    await w.findAll(".rtab")[1]?.trigger("click");
    await flushPromises();
    await w.findAll("header button").find((b) => b.text().includes("CSV"))?.trigger("click");
    expect(clicks[1]).toMatch(/-2\.csv$/);
    w.unmount();
  });

  /**
   * **タブごとに表のインスタンスを保つ**（KeepAlive）ことの確認。
   * 手で決めた列幅が切り替えて戻っても残る＝作り直していない。
   * 作り直していると 200 行 × 40 列で 220〜280ms のブロッキングが出る（実測）。
   */
  it("タブを切り替えて戻っても、手で決めた列幅が残る", async () => {
    mockSequence([{ body: result("A", 2) }, { body: result("B", 2) }]);
    const w = await run("SELECT A FROM T1; SELECT B FROM T2");

    // 1 つ目のタブで列幅を掴んで動かす。
    // （test-utils の trigger は clientX を後から代入するため jsdom で落ちる。
    //   sql-pane.test.ts と同じくイベントを直接組み立てる）
    const el = w.findAll("thead .col-grip")[0]?.element as HTMLElement;
    const at = (type: string, x: number) =>
      el.dispatchEvent(new MouseEvent(type, { clientX: x, bubbles: true, cancelable: true }));
    at("pointerdown", 100);
    at("pointermove", 400);
    at("pointerup", 400);
    await flushPromises();
    const widened = w.findAll("thead th")[1]?.attributes("style");
    expect(widened).toContain("width: 300px");

    // 2 つ目へ行って戻る
    await w.findAll(".rtab")[1]?.trigger("click");
    await flushPromises();
    await w.findAll(".rtab")[0]?.trigger("click");
    await flushPromises();

    expect(w.findAll("thead th")[1]?.attributes("style")).toBe(widened);
    w.unmount();
  });

  it("再実行のたびに前の結果セットを手放す", async () => {
    mockSequence([
      { body: { ...result("A", 2), resultSetId: "rs-1", hasMore: true } },
      { body: { ...result("B", 2), resultSetId: "rs-2", hasMore: true } }
    ]);
    const w = await run("SELECT A FROM T1; SELECT B FROM T2");
    expect(w.findAll(".rtab")).toHaveLength(2);

    const deletes: string[] = [];
    const prev = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (init?.method === "DELETE") deletes.push(String(url));
      return prev(url as string, init);
    }) as typeof fetch;

    await w.find("header button").trigger("click");
    await flushPromises();
    // **開いていた 2 本とも返す**（1 本でも残すと接続がプールに戻らない）
    expect(deletes).toEqual(["/api/host/sql/rs-1", "/api/host/sql/rs-2"]);
    w.unmount();
  });
});
