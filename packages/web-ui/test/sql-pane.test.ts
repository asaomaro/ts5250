import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import SqlPane from "../src/components/SqlPane.vue";
import { systemsStore } from "../src/stores/systems.js";

/**
 * SQL ペイン。実際の実行は実機でしか確かめられないので、
 * ここでは**送信内容・エラー表示・打ち切り表示・CSV の導線**を固定する。
 */
const originalFetch = globalThis.fetch;

const SYSTEM = { ref: "own:s1", name: "自分のシステム", host: "h", autoSignon: false };

function selectSystem(): void {
  systemsStore.systems = [SYSTEM];
  systemsStore.sessions = [];
  systemsStore.loaded = true;
  systemsStore.select(SYSTEM.ref);
}

function mockFetch(body: unknown): void {
  globalThis.fetch = vi.fn(async () => {
    return {
      ok: !(body as { __status?: number }).__status,
      json: async () => body
    } as Response;
  }) as typeof fetch;
}

const OK_BODY = {
  columns: [
    { name: "ID", typeName: "INTEGER", nullable: false },
    { name: "NAME", typeName: "VARCHAR", nullable: true }
  ],
  rows: [
    { ID: 1, NAME: "あ" },
    { ID: 2, NAME: null }
  ],
  rowCount: 2,
  truncated: false
};

beforeEach(() => {
  selectSystem();
  mockFetch(OK_BODY);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  systemsStore.systems = [];
  systemsStore.sessions = [];
  systemsStore.loaded = false;
  vi.restoreAllMocks();
});

async function run(sql = "SELECT 1 FROM SYSIBM.SYSDUMMY1") {
  const w = mount(SqlPane, { props: { tabId: "sql:query" } });
  await w.find("textarea").setValue(sql);
  await w.find("header button").trigger("click");
  await flushPromises();
  return w;
}

describe("実行", () => {
  it("選択中のシステムと SQL と maxRows を送る", async () => {
    const w = await run("SELECT 1 FROM SYSIBM.SYSDUMMY1");
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(call?.[0])).toBe("/api/host/sql");
    const body = JSON.parse(String((call?.[1] as RequestInit).body));
    expect(body.source).toEqual({ system: "own:s1" });
    expect(body.sql).toBe("SELECT 1 FROM SYSIBM.SYSDUMMY1");
    expect(body.maxRows).toBe(200);
    w.unmount();
  });

  it("SQL が空なら実行ボタンが押せない", async () => {
    const w = mount(SqlPane, { props: { tabId: "sql:query" } });
    await flushPromises();
    expect(w.find("header button").attributes("disabled")).toBeDefined();
    w.unmount();
  });

  it("結果を列名つきの表で出し、NULL を明示する", async () => {
    const w = await run();
    expect(w.findAll("th").map((t) => t.text())).toEqual(["ID", "NAME"]);
    expect(w.findAll("tbody tr")).toHaveLength(2);
    expect(w.find(".null").text()).toBe("NULL");
    w.unmount();
  });

  it("0 行なら該当なしを出す", async () => {
    mockFetch({ columns: [], rows: [], rowCount: 0, truncated: false });
    const w = await run();
    expect(w.text()).toContain("該当する行はありません");
    w.unmount();
  });
});

describe("エラー表示", () => {
  it("SQLCODE / SQLSTATE を併記する（文法誤りと権限不足を区別できるように）", async () => {
    mockFetch({
      __status: 400,
      error: "prepare failed",
      code: "SQL_ERROR",
      sqlCode: -204,
      sqlState: "42704"
    });
    const w = await run();
    expect(w.find(".error").text()).toContain("prepare failed");
    expect(w.find(".error").text()).toContain("SQLCODE=-204");
    expect(w.find(".error").text()).toContain("SQLSTATE=42704");
    w.unmount();
  });

  it("メッセージが既に SQLCODE を含むなら二重に出さない", async () => {
    // core は `prepare failed: SQLCODE=-204 SQLSTATE=42704` の形で返すことがある。
    // 実ブラウザ確認で二重表示になっているのを見つけた
    mockFetch({
      __status: 400,
      error: "prepare failed: SQLCODE=-204 SQLSTATE=42704",
      code: "SQL_ERROR",
      sqlCode: -204,
      sqlState: "42704"
    });
    const w = await run();
    const text = w.find(".error").text();
    expect(text.match(/SQLCODE/g)).toHaveLength(1);
    expect(w.find(".detail").exists()).toBe(false);
    w.unmount();
  });

  it("SQLCODE が無いエラーでも本文を出す", async () => {
    mockFetch({ __status: 400, error: "ユーザーとパスワードが登録されていません", code: "CONFIG_ERROR" });
    const w = await run();
    expect(w.find(".error").text()).toContain("ユーザーとパスワード");
    w.unmount();
  });

  it("システム未選択なら実行せず理由を出す", async () => {
    systemsStore.systems = [];
    systemsStore.select("");
    const w = mount(SqlPane, { props: { tabId: "sql:query" } });
    await w.find("textarea").setValue("SELECT 1");
    await flushPromises();
    // 選択が無いのでボタンは無効。fetch は呼ばれない
    expect(w.find("header button").attributes("disabled")).toBeDefined();
    expect(globalThis.fetch as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    w.unmount();
  });
});

describe("打ち切り", () => {
  it("truncated なら警告を出す", async () => {
    mockFetch({ ...OK_BODY, truncated: true });
    const w = await run();
    expect(w.find(".warn").text()).toContain("打ち切りました");
    w.unmount();
  });

  it("truncated でなければ警告を出さない", async () => {
    const w = await run();
    expect(w.find(".warn").exists()).toBe(false);
    w.unmount();
  });
});

describe("CSV ダウンロード", () => {
  it("結果が無いときはボタンを出さない", async () => {
    mockFetch({ columns: [], rows: [], rowCount: 0, truncated: false });
    const w = await run();
    expect(w.find("button.link").exists()).toBe(false);
    w.unmount();
  });

  it("結果があれば Blob URL を作って a.click で落とす", async () => {
    const createURL = vi.fn(() => "blob:x");
    const revokeURL = vi.fn();
    vi.stubGlobal("URL", { ...URL, createObjectURL: createURL, revokeObjectURL: revokeURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    const w = await run();
    await w.find("button.link").trigger("click");

    expect(createURL).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
    // 解放しないと Blob がタブの寿命だけ残る
    expect(revokeURL).toHaveBeenCalledWith("blob:x");
    vi.unstubAllGlobals();
    w.unmount();
  });
});
