import { describe, it, expect, vi } from "vitest";
import { ResultSetStore } from "../src/result-set-store.js";
import type { ColumnMeta, DbConnection, Row } from "@as400web/core";

/**
 * 結果セットの保持。
 *
 * **このアプリで唯一「接続を掴み続ける」場所**なので、歯止め
 * （アイドル・上限・終了時クローズ）をテストで固定する。
 * 掴んだまま漏れると、実機の接続を食い潰す種類の失敗になる。
 */
function fakeConn(): { conn: DbConnection; closed: () => boolean } {
  let closed = false;
  return {
    conn: { close: () => { closed = true; } } as unknown as DbConnection,
    closed: () => closed
  };
}

async function* rowsOf(n: number): AsyncGenerator<Row, void, undefined> {
  for (let i = 0; i < n; i++) yield { ID: i } as Row;
}

const columns: ColumnMeta[] = [];

describe("ページング", () => {
  it("指定件数ずつ返し、続きがあるかを示す", async () => {
    const store = new ResultSetStore();
    const set = store.open({ owner: undefined, columns, rows: rowsOf(5), conn: fakeConn().conn });

    let page = await store.next(set, 2);
    expect(page.rows.map((r) => r.ID)).toEqual([0, 1]);
    expect(page.hasMore).toBe(true);

    page = await store.next(set, 2);
    expect(page.rows.map((r) => r.ID)).toEqual([2, 3]);
    expect(page.hasMore).toBe(true);

    page = await store.next(set, 2);
    expect(page.rows.map((r) => r.ID)).toEqual([4]);
    expect(page.hasMore).toBe(false);
  });

  it("**件数がちょうど割り切れても余計なページを作らない**", async () => {
    // #99 で「ちょうど倍数」の経路を踏んでいるので、ここも固定する
    const store = new ResultSetStore();
    const set = store.open({ owner: undefined, columns, rows: rowsOf(4), conn: fakeConn().conn });
    let page = await store.next(set, 2);
    expect(page.hasMore).toBe(true);
    page = await store.next(set, 2);
    expect(page.rows.map((r) => r.ID)).toEqual([2, 3]);
    expect(page.hasMore).toBe(false); // 5 ページ目を作らない
  });

  it("0 行でも壊れない", async () => {
    const store = new ResultSetStore();
    const set = store.open({ owner: undefined, columns, rows: rowsOf(0), conn: fakeConn().conn });
    const page = await store.next(set, 10);
    expect(page.rows).toEqual([]);
    expect(page.hasMore).toBe(false);
  });
});

describe("歯止め", () => {
  it("アイドルで閉じ、接続も閉じる", async () => {
    let now = 1000;
    const store = new ResultSetStore(60_000, 4, () => now);
    const c = fakeConn();
    const set = store.open({ owner: undefined, columns, rows: rowsOf(3), conn: c.conn });
    expect(store.size).toBe(1);

    now += 59_000;
    store.sweep();
    expect(store.size).toBe(1); // まだ生きている

    now += 2_000;
    store.sweep();
    expect(store.size).toBe(0);
    expect(c.closed()).toBe(true); // **接続を掴んだままにしない**
    expect(store.get(set.id, undefined)).toBeUndefined();
  });

  it("使うたびにアイドル時計が戻る", async () => {
    let now = 1000;
    const store = new ResultSetStore(60_000, 4, () => now);
    const set = store.open({ owner: undefined, columns, rows: rowsOf(10), conn: fakeConn().conn });
    now += 50_000;
    await store.next(set, 1);
    now += 50_000;
    store.sweep();
    expect(store.size).toBe(1);
  });

  it("**1 利用者の上限を超えたら最も古いものを閉じる**", () => {
    let now = 1000;
    const store = new ResultSetStore(60_000, 2, () => now);
    const first = store.open({ owner: "alice", columns, rows: rowsOf(1), conn: fakeConn().conn });
    now += 10;
    store.open({ owner: "alice", columns, rows: rowsOf(1), conn: fakeConn().conn });
    now += 10;
    store.open({ owner: "alice", columns, rows: rowsOf(1), conn: fakeConn().conn });
    expect(store.size).toBe(2);
    expect(store.get(first.id, { username: "alice", role: "user" })).toBeUndefined();
  });

  it("上限は利用者ごとに数える", () => {
    const store = new ResultSetStore(60_000, 1, () => 1000);
    store.open({ owner: "alice", columns, rows: rowsOf(1), conn: fakeConn().conn });
    store.open({ owner: "bob", columns, rows: rowsOf(1), conn: fakeConn().conn });
    expect(store.size).toBe(2);
  });

  it("**closeAll で全部閉じる**（プロセス終了時に接続を残さない）", () => {
    const store = new ResultSetStore();
    const a = fakeConn();
    const b = fakeConn();
    store.open({ owner: undefined, columns, rows: rowsOf(1), conn: a.conn });
    store.open({ owner: undefined, columns, rows: rowsOf(1), conn: b.conn });
    store.closeAll();
    expect(store.size).toBe(0);
    expect(a.closed()).toBe(true);
    expect(b.closed()).toBe(true);
  });

  it("close はジェネレータも閉じる（カーソルを残さない）", () => {
    const store = new ResultSetStore();
    const rows = rowsOf(100);
    const ret = vi.spyOn(rows, "return");
    const set = store.open({ owner: undefined, columns, rows, conn: fakeConn().conn });
    store.close(set.id);
    expect(ret).toHaveBeenCalled();
  });
});

describe("所有", () => {
  it("他人の結果セットには触れない", () => {
    const store = new ResultSetStore();
    const set = store.open({ owner: "alice", columns, rows: rowsOf(1), conn: fakeConn().conn });
    expect(() => store.get(set.id, { username: "bob", role: "user" })).toThrow();
  });

  it("所有者本人は取れる", () => {
    const store = new ResultSetStore();
    const set = store.open({ owner: "alice", columns, rows: rowsOf(1), conn: fakeConn().conn });
    expect(store.get(set.id, { username: "alice", role: "user" })).toBeDefined();
  });

  it("admin は取れる", () => {
    const store = new ResultSetStore();
    const set = store.open({ owner: "alice", columns, rows: rowsOf(1), conn: fakeConn().conn });
    expect(store.get(set.id, { username: "root", role: "admin" })).toBeDefined();
  });

  it("認証オフ（owner なし）は取れる", () => {
    const store = new ResultSetStore();
    const set = store.open({ owner: undefined, columns, rows: rowsOf(1), conn: fakeConn().conn });
    expect(store.get(set.id, undefined)).toBeDefined();
  });
});
