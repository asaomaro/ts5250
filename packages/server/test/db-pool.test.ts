import { describe, it, expect, vi } from "vitest";
import { DbPool, poolKey } from "../src/db-pool.js";
import type { DbConnection } from "@as400web/core";

/**
 * 接続の使い回し。
 *
 * 接続の確立が実測で約 4.6 秒かかるため導入したもの（理由は `db-pool.ts`）。
 * 速さのために接続を掴む以上、**貸し出しの排他・利用者の分離・後始末**を
 * テストで固定する。ここが緩むと「他人の接続で SQL が通る」種類の失敗になる。
 */
function fakeConn(): { conn: DbConnection; closed: () => boolean } {
  let closed = false;
  return {
    conn: { close: () => { closed = true; } } as unknown as DbConnection,
    closed: () => closed
  };
}

const AUTH = { host: "h", user: "USER", password: "p" };

describe("鍵の分離", () => {
  it("利用者が違えば別の鍵になる（**他人の接続を貸さない**）", () => {
    expect(poolKey("alice", AUTH)).not.toBe(poolKey("bob", AUTH));
  });

  it("**パスワードが違えば別の鍵**（誤りに変えた後も通ってしまわないように）", () => {
    expect(poolKey("alice", AUTH)).not.toBe(poolKey("alice", { ...AUTH, password: "other" }));
  });

  it("鍵にパスワードそのものを載せない", () => {
    expect(poolKey("alice", AUTH)).not.toContain("p");
  });

  it("同じ資格情報なら同じ鍵", () => {
    expect(poolKey("alice", AUTH)).toBe(poolKey("alice", { ...AUTH }));
  });
});

describe("貸し借り", () => {
  it("待機が無ければ開き、返せば次は使い回す", async () => {
    const pool = new DbPool();
    const open = vi.fn(async () => fakeConn().conn);
    const key = poolKey(undefined, AUTH);

    const first = await pool.acquire(key, open);
    expect(first.reused).toBe(false);
    expect(open).toHaveBeenCalledTimes(1);

    pool.release(key, first.conn);
    const second = await pool.acquire(key, open);
    expect(second.reused).toBe(true);
    expect(second.conn).toBe(first.conn);
    expect(open).toHaveBeenCalledTimes(1); // 開き直していない
  });

  it("**貸し出し中のものは他へ貸さない**（同じ接続を 2 箇所が使わない）", async () => {
    const pool = new DbPool();
    const key = poolKey(undefined, AUTH);
    const a = await pool.acquire(key, async () => fakeConn().conn);
    const b = await pool.acquire(key, async () => fakeConn().conn);
    expect(b.conn).not.toBe(a.conn);
    expect(pool.idleSize).toBe(0); // どちらも貸し出し中
  });

  it("鍵が違えば使い回さない", async () => {
    const pool = new DbPool();
    const mine = poolKey("alice", AUTH);
    const yours = poolKey("bob", AUTH);
    const c = fakeConn();
    pool.release(mine, c.conn);
    const got = await pool.acquire(yours, async () => fakeConn().conn);
    expect(got.reused).toBe(false);
    expect(got.conn).not.toBe(c.conn);
  });

  it("discard は閉じて、使い回さない", async () => {
    const pool = new DbPool();
    const c = fakeConn();
    pool.discard(c.conn);
    expect(c.closed()).toBe(true);
    expect(pool.idleSize).toBe(0);
  });
});

describe("歯止め", () => {
  it("鍵ごとの待機本数を超えた分は閉じる", () => {
    const pool = new DbPool(60_000, 1, () => 1000);
    const key = poolKey(undefined, AUTH);
    const a = fakeConn();
    const b = fakeConn();
    pool.release(key, a.conn);
    pool.release(key, b.conn);
    expect(pool.idleSize).toBe(1);
    expect(b.closed()).toBe(true);
  });

  it("アイドルで閉じる", async () => {
    let now = 1000;
    const pool = new DbPool(60_000, 2, () => now);
    const key = poolKey(undefined, AUTH);
    const c = fakeConn();
    pool.release(key, c.conn);

    now += 59_000;
    pool.sweep();
    expect(pool.idleSize).toBe(1);

    now += 2_000;
    pool.sweep();
    expect(pool.idleSize).toBe(0);
    expect(c.closed()).toBe(true);
  });

  it("**closeAll で全部閉じる**（プロセス終了時に接続を残さない）", () => {
    const pool = new DbPool();
    const a = fakeConn();
    const b = fakeConn();
    pool.release(poolKey("alice", AUTH), a.conn);
    pool.release(poolKey("bob", AUTH), b.conn);
    pool.closeAll();
    expect(pool.idleSize).toBe(0);
    expect(a.closed()).toBe(true);
    expect(b.closed()).toBe(true);
  });
});

describe("暖機", () => {
  it("待機が無ければ 1 本開いて待たせる", async () => {
    const pool = new DbPool();
    const key = poolKey(undefined, AUTH);
    await pool.warm(key, async () => fakeConn().conn);
    expect(pool.idleSize).toBe(1);
    expect((await pool.acquire(key, async () => fakeConn().conn)).reused).toBe(true);
  });

  it("すでに待機があれば増やさない（何度開いても溜め込まない）", async () => {
    const pool = new DbPool();
    const key = poolKey(undefined, AUTH);
    const open = vi.fn(async () => fakeConn().conn);
    await pool.warm(key, open);
    await pool.warm(key, open);
    await pool.warm(key, open);
    expect(open).toHaveBeenCalledTimes(1);
    expect(pool.idleSize).toBe(1);
  });
});
