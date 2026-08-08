import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import SqlPane from "../src/components/SqlPane.vue";
import { systemsStore } from "../src/stores/systems.js";
import { clearColumnCache } from "../src/sqlColumns.js";

/**
 * SQL 欄のキー操作と列の補完を、ペインに組み込んだ状態で見る。
 *
 * 文字列操作そのものは `sql-edit.test.ts` / `sql-refs.test.ts` が押さえているので、
 * ここは**配線**——キーが拾えているか、候補がホストの応答から出るか、確定で入るか。
 */
const originalFetch = globalThis.fetch;
const SYSTEM = { ref: "own:s1", name: "自分のシステム", host: "h", autoSignon: false };

function selectSystem(): void {
  systemsStore.systems = [SYSTEM];
  systemsStore.sessions = [];
  systemsStore.loaded = true;
  systemsStore.select(SYSTEM.ref);
}

/** `SYSCOLUMNS` / `SYSTABLES` への問い合わせにだけ答える偽 fetch */
function mockCatalog(columns: string[], tables: string[] = []): { asked: string[] } {
  const asked: string[] = [];
  globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as { sql?: string }) : {};
    if (String(url) === "/api/host/sql" && body.sql?.includes("SYSCOLUMNS")) {
      asked.push(body.sql);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          rows: columns.map((n) => ({ COLUMN_NAME: n, DATA_TYPE: "CHAR", COLUMN_TEXT: `${n} の説明` }))
        })
      } as Response;
    }
    if (String(url) === "/api/host/sql" && body.sql?.includes("SYSTABLES")) {
      asked.push(body.sql);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          rows: tables.map((n) => ({ TABLE_NAME: n, TABLE_TYPE: "T", TABLE_TEXT: `${n} の説明` }))
        })
      } as Response;
    }
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  }) as typeof fetch;
  return { asked };
}

/** 列だけを返す（表の候補は使わないテスト向け） */
const mockColumns = (names: string[]) => mockCatalog(names);

beforeEach(() => {
  selectSystem();
  clearColumnCache();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  systemsStore.systems = [];
  systemsStore.loaded = false;
  vi.restoreAllMocks();
});

function open() {
  return mount(SqlPane, { props: { tabId: "sql:query", system: SYSTEM.ref }, attachTo: document.body });
}

/** 入力欄に文字を入れ、キャレットを末尾に置く */
async function type(w: ReturnType<typeof open>, text: string) {
  const ta = w.find("textarea");
  await ta.setValue(text);
  const el = ta.element as HTMLTextAreaElement;
  el.selectionStart = text.length;
  el.selectionEnd = text.length;
  return ta;
}

describe("キー操作", () => {
  it("Ctrl+/ でコメントが付く", async () => {
    mockColumns([]);
    const w = open();
    const ta = await type(w, "SELECT 1");
    await ta.trigger("keydown", { key: "/", ctrlKey: true });
    await flushPromises();
    expect((ta.element as HTMLTextAreaElement).value).toBe("-- SELECT 1");
    w.unmount();
  });

  it("もう一度 Ctrl+/ で外れる", async () => {
    mockColumns([]);
    const w = open();
    const ta = await type(w, "-- SELECT 1");
    await ta.trigger("keydown", { key: "/", ctrlKey: true });
    await flushPromises();
    expect((ta.element as HTMLTextAreaElement).value).toBe("SELECT 1");
    w.unmount();
  });

  it("Tab で字下げが増える", async () => {
    mockColumns([]);
    const w = open();
    const ta = await type(w, "SELECT 1");
    const el = ta.element as HTMLTextAreaElement;
    el.selectionStart = 0;
    el.selectionEnd = 8;
    await ta.trigger("keydown", { key: "Tab" });
    await flushPromises();
    expect(el.value).toBe("  SELECT 1");
    w.unmount();
  });

  it("Shift+Tab で戻る", async () => {
    mockColumns([]);
    const w = open();
    const ta = await type(w, "  SELECT 1");
    const el = ta.element as HTMLTextAreaElement;
    el.selectionStart = 0;
    el.selectionEnd = 10;
    await ta.trigger("keydown", { key: "Tab", shiftKey: true });
    await flushPromises();
    expect(el.value).toBe("SELECT 1");
    w.unmount();
  });

  /**
   * Tab を奪うとキーボードだけで欄から出られなくなる。
   * **Esc の直後の Tab は素通しする**のが逃げ道。
   */
  it("Esc の直後の Tab は字下げにしない（欄から出られる）", async () => {
    mockColumns([]);
    const w = open();
    const ta = await type(w, "SELECT 1");
    await ta.trigger("keydown", { key: "Escape" });
    await ta.trigger("keydown", { key: "Tab" });
    await flushPromises();
    expect((ta.element as HTMLTextAreaElement).value).toBe("SELECT 1");
    w.unmount();
  });
});

describe("列の候補", () => {
  const SQL = "SELECT * FROM TESTLIB.M_MENU T1 WHERE T1.";

  it("`別名.` で候補が出る", async () => {
    mockColumns(["MENUCD", "MENUNM"]);
    const w = open();
    const ta = await type(w, SQL);
    await ta.trigger("input");
    await flushPromises();
    expect(w.find(".sqlc").exists()).toBe(true);
    expect(w.findAll(".sqlc-name").map((n) => n.text())).toEqual(["MENUCD", "MENUNM"]);
    w.unmount();
  });

  it("**別名から表を解いて**問い合わせる（ライブラリーも渡す）", async () => {
    const { asked } = mockColumns(["MENUCD"]);
    const w = open();
    const ta = await type(w, SQL);
    await ta.trigger("input");
    await flushPromises();
    expect(asked[0]).toContain("TABLE_NAME = 'M_MENU'");
    expect(asked[0]).toContain("TABLE_SCHEMA = 'TESTLIB'");
    w.unmount();
  });

  it("打ちかけの文字で絞り込む", async () => {
    mockColumns(["MENUCD", "MENUNM", "SORTNO"]);
    const w = open();
    const ta = await type(w, `${SQL}MENU`);
    await ta.trigger("input");
    await flushPromises();
    expect(w.findAll(".sqlc-name").map((n) => n.text())).toEqual(["MENUCD", "MENUNM"]);
    w.unmount();
  });

  it("Enter で確定して打ちかけの文字を置き換える", async () => {
    mockColumns(["MENUCD", "MENUNM"]);
    const w = open();
    const ta = await type(w, `${SQL}MENUN`);
    await ta.trigger("input");
    await flushPromises();
    await ta.trigger("keydown", { key: "Enter" });
    await flushPromises();
    expect((ta.element as HTMLTextAreaElement).value).toBe(`${SQL}MENUNM`);
    expect(w.find(".sqlc").exists()).toBe(false);
    w.unmount();
  });

  it("↓ で選び直せる", async () => {
    mockColumns(["MENUCD", "MENUNM"]);
    const w = open();
    const ta = await type(w, SQL);
    await ta.trigger("input");
    await flushPromises();
    await ta.trigger("keydown", { key: "ArrowDown" });
    await ta.trigger("keydown", { key: "Enter" });
    await flushPromises();
    expect((ta.element as HTMLTextAreaElement).value).toBe(`${SQL}MENUNM`);
    w.unmount();
  });

  it("Esc で閉じる（文字は変えない）", async () => {
    mockColumns(["MENUCD"]);
    const w = open();
    const ta = await type(w, SQL);
    await ta.trigger("input");
    await flushPromises();
    await ta.trigger("keydown", { key: "Escape" });
    await flushPromises();
    expect(w.find(".sqlc").exists()).toBe(false);
    expect((ta.element as HTMLTextAreaElement).value).toBe(SQL);
    w.unmount();
  });

  it("解けない修飾子では出さない", async () => {
    mockColumns(["MENUCD"]);
    const w = open();
    const ta = await type(w, "SELECT * FROM TESTLIB.M_MENU T1 WHERE ZZ.");
    await ta.trigger("input");
    await flushPromises();
    expect(w.find(".sqlc").exists()).toBe(false);
    w.unmount();
  });

  /** 候補のためにエラーを出して書く手を止めない */
  it("列が引けなくても黙って閉じる", async () => {
    mockColumns([]);
    const w = open();
    const ta = await type(w, SQL);
    await ta.trigger("input");
    await flushPromises();
    expect(w.find(".sqlc").exists()).toBe(false);
    expect(w.find(".error").exists()).toBe(false);
    w.unmount();
  });

  it("候補が出ている間の Tab は字下げではなく確定", async () => {
    mockColumns(["MENUCD"]);
    const w = open();
    const ta = await type(w, SQL);
    await ta.trigger("input");
    await flushPromises();
    await ta.trigger("keydown", { key: "Tab" });
    await flushPromises();
    expect((ta.element as HTMLTextAreaElement).value).toBe(`${SQL}MENUCD`);
    w.unmount();
  });
});

/**
 * `ライブラリー.` で**表の一覧**を出す（利用者の要望）。
 * `FROM TESTLIB.` は `tableRefsOf` から見ると「`TESTLIB` という表」に見えるので、
 * 書く位置で先に判別できているかも一緒に確かめる。
 */
describe("表の候補", () => {
  it("`FROM ライブラリー.` で表の一覧が出る", async () => {
    mockCatalog([], ["M_MENU", "M_MENUTR"]);
    const w = open();
    const ta = await type(w, "SELECT * FROM TESTLIB.");
    await ta.trigger("input");
    await flushPromises();
    expect(w.findAll(".sqlc-name").map((n) => n.text())).toEqual(["M_MENU", "M_MENUTR"]);
    w.unmount();
  });

  it("**列ではなく表を問い合わせる**（`TESTLIB` という表を探しに行かない）", async () => {
    const { asked } = mockCatalog([], ["M_MENU"]);
    const w = open();
    const ta = await type(w, "SELECT * FROM TESTLIB.");
    await ta.trigger("input");
    await flushPromises();
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("SYSTABLES");
    expect(asked[0]).toContain("TABLE_SCHEMA = 'TESTLIB'");
    w.unmount();
  });

  it("打ちかけの文字で絞り込む", async () => {
    mockCatalog([], ["M_MENU", "M_MENUTR", "EMPMST"]);
    const w = open();
    const ta = await type(w, "SELECT * FROM TESTLIB.M_MENUT");
    await ta.trigger("input");
    await flushPromises();
    expect(w.findAll(".sqlc-name").map((n) => n.text())).toEqual(["M_MENUTR"]);
    w.unmount();
  });

  it("確定すると表名が入る", async () => {
    mockCatalog([], ["M_MENU"]);
    const w = open();
    const ta = await type(w, "SELECT * FROM TESTLIB.");
    await ta.trigger("input");
    await flushPromises();
    await ta.trigger("keydown", { key: "Enter" });
    await flushPromises();
    expect((ta.element as HTMLTextAreaElement).value).toBe("SELECT * FROM TESTLIB.M_MENU");
    w.unmount();
  });

  /** 表の位置でなくても、別名・表名で解けない修飾子はライブラリーとみなす */
  it("`WHERE ライブラリー.` でも表の一覧に落とす", async () => {
    const { asked } = mockCatalog([], ["M_MENU"]);
    const w = open();
    const ta = await type(w, "SELECT * FROM TESTLIB.M_MENU T1 WHERE TESTLIB.");
    await ta.trigger("input");
    await flushPromises();
    expect(asked[0]).toContain("SYSTABLES");
    w.unmount();
  });

  it("別名が解ければ列のまま（表の一覧に落ちない）", async () => {
    const { asked } = mockCatalog(["MENUCD"], ["M_MENU"]);
    const w = open();
    const ta = await type(w, "SELECT * FROM TESTLIB.M_MENU T1 WHERE T1.");
    await ta.trigger("input");
    await flushPromises();
    expect(asked[0]).toContain("SYSCOLUMNS");
    expect(w.findAll(".sqlc-name").map((n) => n.text())).toEqual(["MENUCD"]);
    w.unmount();
  });
});
