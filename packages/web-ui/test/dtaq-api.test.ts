import { describe, it, expect, afterEach, vi } from "vitest";
import {
  send,
  receive,
  create,
  clear,
  attributes,
  listEntries,
  messageFor,
  isValidObjectName,
  KNOWN_ERROR_CODES,
  DtaqRequestError
} from "../src/dtaqApi.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** route→応答本文（と status）を返す fetch モック。呼ばれた (url, body) を記録する */
function mockFetch(handler: (url: string, body: unknown) => { status?: number; body: unknown }) {
  const calls: { url: string; body: unknown }[] = [];
  globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: u, body });
    const r = handler(u, body);
    return new Response(JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;
  return calls;
}

const SRC = { system: "srv:s" };

describe("isValidObjectName", () => {
  it("通常名は通る", () => {
    expect(isValidObjectName("MYLIB")).toBe(true);
    expect(isValidObjectName("MY_DTAQ$")).toBe(true);
  });
  it("空・10 文字超・不正文字・クォートは弾く", () => {
    expect(isValidObjectName("")).toBe(false);
    expect(isValidObjectName("TOOLONGNAME1")).toBe(false);
    expect(isValidObjectName("A B")).toBe(false);
    expect(isValidObjectName("A'B")).toBe(false); // SQL インジェクションの芽
  });
});

describe("messageFor", () => {
  it("KNOWN_ERROR_CODES をすべて日本語化する（英語の生文言に落ちない）", () => {
    for (const code of KNOWN_ERROR_CODES) {
      const msg = messageFor({ error: "raw english", code });
      // CONFIG_ERROR は error 本文を活かすので、少なくとも生文言のままではない条件は緩める
      expect(msg.length).toBeGreaterThan(0);
      if (code !== "CONFIG_ERROR") expect(msg).not.toBe("raw english");
    }
  });
  it("未知の code はサーバー文言をそのまま返す", () => {
    expect(messageFor({ error: "boom", code: "WEIRD" })).toBe("boom");
  });
});

describe("送受信・管理の呼び出し", () => {
  it("send は /api/host/dtaq/send に data/encoding/key を渡す", async () => {
    const calls = mockFetch(() => ({ body: { ok: true } }));
    await send(SRC, "MYLIB", "Q", { data: "hi", encoding: "base64", key: "0010" });
    expect(calls[0]?.url).toContain("/api/host/dtaq/send");
    expect(calls[0]?.body).toMatchObject({ library: "MYLIB", name: "Q", data: "hi", encoding: "base64", key: "0010" });
  });

  it("receive は entry を返す（空は null）", async () => {
    mockFetch(() => ({ body: { entry: null } }));
    expect((await receive(SRC, "MYLIB", "Q", { wait: 0 })).entry).toBeNull();
  });

  it("create/clear/attributes を叩く", async () => {
    const calls = mockFetch((u) =>
      u.endsWith("/attributes")
        ? { body: { maxEntryLength: 100, type: "FIFO", keyLength: 0, saveSender: false } }
        : { body: { ok: true } }
    );
    await create(SRC, "MYLIB", "Q", { maxEntryLength: 100, type: "FIFO" });
    await clear(SRC, "MYLIB", "Q");
    const a = await attributes(SRC, "MYLIB", "Q");
    expect(a.type).toBe("FIFO");
    expect(calls.map((c) => c.url.split("/dtaq/")[1])).toEqual(["create", "clear", "attributes"]);
  });

  it("エラー応答は DtaqRequestError（日本語文言）で投げる", async () => {
    mockFetch(() => ({ status: 404, body: { error: "not found", code: "NOT_FOUND" } }));
    await expect(send(SRC, "MYLIB", "Q", { data: "x" })).rejects.toBeInstanceOf(DtaqRequestError);
    await expect(send(SRC, "MYLIB", "Q", { data: "x" })).rejects.toThrow(/見つかりません/);
  });
});

describe("listEntries（SQL 経由）", () => {
  it("不正なキュー名は SQL を投げる前に弾く", async () => {
    const calls = mockFetch(() => ({ body: { rows: [] } }));
    await expect(listEntries(SRC, "MYLIB", "A'B")).rejects.toThrow(/キュー名/);
    // fetch は呼ばれない（SQL を組み立てる前に弾く）
    expect(calls).toHaveLength(0);
  });

  it("/api/host/sql に DATA_QUEUE_ENTRIES の SELECT を投げ、行を写像する", async () => {
    const calls = mockFetch((u) => {
      expect(u).toContain("/api/host/sql");
      return {
        body: {
          rows: [
            { POS: 1, DATA_EBCDIC: "hello", BYTES: 5, HEX64: "68656C6C6F", ENQUEUED: "2026-07-21-00.00.00", SENDER: "J/U/QZRCSRVS" }
          ]
        }
      };
    });
    const rows = await listEntries(SRC, "MYLIB", "Q");
    const sql = (calls[0]?.body as { sql: string }).sql;
    expect(sql).toContain("QSYS2.DATA_QUEUE_ENTRIES");
    expect(sql).toContain("'MYLIB'");
    expect(sql).toContain("'Q'");
    expect(rows).toEqual([
      { position: 1, textEbcdic: "hello", bytes: 5, hex: "68656C6C6F", enqueuedAt: "2026-07-21-00.00.00", sender: "J/U/QZRCSRVS" }
    ]);
  });

  it("SQL がエラーなら DtaqRequestError", async () => {
    mockFetch(() => ({ status: 400, body: { error: "prepare failed", code: "SQL_ERROR" } }));
    await expect(listEntries(SRC, "MYLIB", "Q")).rejects.toBeInstanceOf(DtaqRequestError);
  });
});
