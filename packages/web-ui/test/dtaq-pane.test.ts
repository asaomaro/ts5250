import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import DtaqPane from "../src/components/DtaqPane.vue";
import { systemsStore } from "../src/stores/systems.js";

/**
 * データ待ち行列パネル。**送受信・一覧・属性が画面にどう出るか**を、
 * 偽 fetch を差し込んで固定する（描画を通してロジックを検証する）。
 */
const realFetch = globalThis.fetch;
const realSelected = systemsStore.menuSystem;

beforeEach(() => {
  systemsStore.menuSystem = "srv:s";
});
afterEach(() => {
  globalThis.fetch = realFetch;
  systemsStore.menuSystem = realSelected;
});

/** 呼ばれた (route, body) を記録しつつ、route→応答を返す偽 fetch */
function mockFetch(handler: (route: string, body: unknown) => { status?: number; body: unknown }) {
  const calls: { route: string; body: unknown }[] = [];
  globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
    const route = String(url).replace("/api/host/", "");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ route, body });
    const r = handler(route, body);
    return new Response(JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { "content-type": "application/json" }
    });
  }) as unknown as typeof fetch;
  return calls;
}

/** ライブラリー/キューを入れて操作可能な状態にしたパネル */
async function readyPane(handler: (route: string, body: unknown) => { status?: number; body: unknown }) {
  const calls = mockFetch(handler);
  const w = mount(DtaqPane, { props: { tabId: "dtaq:entries", system: "srv:s" } });
  const inputs = w.findAll("input");
  await inputs[0]!.setValue("TESTLIB"); // ライブラリー
  await inputs[1]!.setValue("Q"); // キュー
  await flushPromises();
  return { w, calls };
}

describe("入力ガード", () => {
  it("キュー未指定なら操作ボタンは無効", async () => {
    mockFetch(() => ({ body: {} }));
    const w = mount(DtaqPane, { props: { tabId: "dtaq:entries", system: "srv:s" } });
    await flushPromises();
    // 属性/一覧ボタンが disabled
    const headerButtons = w.find(".head").findAll("button");
    expect(headerButtons.every((b) => (b.element as HTMLButtonElement).disabled)).toBe(true);
    expect(w.text()).toContain("ライブラリーとキュー名を入力してください");
  });
});

describe("送信", () => {
  it("送信ボタンで /dtaq/send を叩き、成功メッセージを出す", async () => {
    const { w, calls } = await readyPane(() => ({ body: { ok: true } }));
    // 送信 textarea に入力
    await w.find("textarea").setValue("hello");
    // 送信ボタン（fieldset 内）
    const sendBtn = w.findAll("button").find((b) => b.text() === "送信")!;
    await sendBtn.trigger("click");
    await flushPromises();
    const call = calls.find((c) => c.route === "dtaq/send");
    expect(call).toBeDefined();
    expect(call!.body).toMatchObject({ library: "TESTLIB", name: "Q", data: "hello" });
    expect(w.text()).toContain("送信しました");
  });
});

describe("受信 / ピーク", () => {
  it("ピークで entry を表示する", async () => {
    const { w } = await readyPane(() => ({
      body: { entry: { data: "hello", encoding: "utf8", bytes: 5, senderInfo: "QUSER" } }
    }));
    const peekBtn = w.findAll("button").find((b) => b.text().includes("ピーク"))!;
    await peekBtn.trigger("click");
    await flushPromises();
    expect(w.text()).toContain("hello");
    expect(w.text()).toContain("QUSER");
    expect(w.text()).toContain("覗きました");
  });

  it("空なら「エントリはありません」を出す", async () => {
    const { w } = await readyPane(() => ({ body: { entry: null } }));
    const recvBtn = w.findAll("button").find((b) => b.text().includes("受信"))!;
    await recvBtn.trigger("click");
    await flushPromises();
    expect(w.text()).toContain("エントリはありません");
  });
});

describe("属性 / 一覧", () => {
  it("属性を表示する", async () => {
    const { w } = await readyPane(() => ({
      body: { maxEntryLength: 333, type: "KEYED", keyLength: 7, saveSender: true }
    }));
    const attrBtn = w.find(".head").findAll("button").find((b) => b.text() === "属性")!;
    await attrBtn.trigger("click");
    await flushPromises();
    expect(w.text()).toContain("333");
    expect(w.text()).toContain("KEYED");
  });

  it("一覧を SQL 経由で取り、行を表に出す", async () => {
    const { w, calls } = await readyPane((route) =>
      route === "sql"
        ? { body: { rows: [{ POS: 1, DATA_EBCDIC: "hi", BYTES: 2, HEX64: "6869", ENQUEUED: "t", SENDER: "s" }] } }
        : { body: {} }
    );
    const listBtn = w.find(".head").findAll("button").find((b) => b.text() === "一覧")!;
    await listBtn.trigger("click");
    await flushPromises();
    // SQL ルートを叩いている
    expect(calls.some((c) => c.route === "sql")).toBe(true);
    // 表に行が出る
    expect(w.find("table").text()).toContain("6869");
    expect(w.text()).toContain("best-effort");
  });
});

describe("クリア", () => {
  it("一覧表示中にクリアすると、一覧を取り直したうえで成功メッセージが残る", async () => {
    // 一覧→クリア（clear と再一覧）の順で応答を返す。再一覧は空
    let cleared = false;
    const { w } = await readyPane((route) => {
      if (route === "sql") return { body: { rows: cleared ? [] : [{ POS: 1, DATA_EBCDIC: "x", BYTES: 1, HEX64: "78", ENQUEUED: "t", SENDER: "s" }] } };
      if (route === "dtaq/clear") {
        cleared = true;
        return { body: { ok: true } };
      }
      return { body: {} };
    });
    // まず一覧を出す
    await w.find(".head").findAll("button").find((b) => b.text() === "一覧")!.trigger("click");
    await flushPromises();
    expect(w.find("table").text()).toContain("78");
    // クリア
    await w.findAll("button").find((b) => b.text() === "クリア")!.trigger("click");
    await flushPromises();
    // **成功メッセージが残る**（onList の message リセットで消えない・E2E で踏んだ回帰）
    expect(w.text()).toContain("クリアしました");
    // 一覧は取り直されて空
    expect(w.find("td.empty").exists()).toBe(true);
  });
});

describe("削除の失敗", () => {
  it("削除が失敗したら、属性表示を畳まずエラーを出す（消えたように見せない）", async () => {
    // 属性は成功、削除は RESOURCE_BUSY で失敗
    const { w } = await readyPane((route) =>
      route === "dtaq/attributes"
        ? { body: { maxEntryLength: 100, type: "FIFO", keyLength: 0, saveSender: false } }
        : { status: 409, body: { error: "busy", code: "RESOURCE_BUSY" } }
    );
    // 属性を出す
    await w.find(".head").findAll("button").find((b) => b.text() === "属性")!.trigger("click");
    await flushPromises();
    expect(w.find(".attrs").exists()).toBe(true);
    // 削除（失敗）
    await w.findAll("button").find((b) => b.text() === "削除")!.trigger("click");
    await flushPromises();
    // 属性表示は残る（まだ存在するので畳まない）／エラーは出る
    expect(w.find(".attrs").exists()).toBe(true);
    expect(w.find(".error").text()).toContain("使用中");
  });
});

describe("エラー表示", () => {
  it("NOT_FOUND は日本語文言を出す", async () => {
    const { w } = await readyPane(() => ({ status: 404, body: { error: "not found", code: "NOT_FOUND" } }));
    const attrBtn = w.find(".head").findAll("button").find((b) => b.text() === "属性")!;
    await attrBtn.trigger("click");
    await flushPromises();
    expect(w.find(".error").text()).toContain("見つかりません");
  });
});
