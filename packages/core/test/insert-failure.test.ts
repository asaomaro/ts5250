import { describe, it, expect, vi } from "vitest";
import { insertRows } from "../src/hostserver/db/insert.js";
import type { DbConnection } from "../src/hostserver/db/db-connection.js";

/**
 * **失敗の検出**。ここはバグが集中した箇所なので、応答を差し替えて経路ごと固定する。
 *
 * この作業で実際に踏んだ失敗:
 *  - マーカーのハンドルを RPB ハンドル欄に入れ、**エラーにならないまま何も起きなかった**
 *  - メッセージ ID の頭文字で成否を判定し、`S0002 Function completed successfully.` を失敗と誤検知した
 *  - SQLCA が無い応答を成功扱いにしていた（レビュー指摘）
 *
 * いずれも「沈黙」か「誤検知」で、実機でしか気づけなかった。応答を作れば単体で固定できる。
 */

/** マーカー形式（CHAR(4) 1 列）。実機の並びに合わせる */
function markerFormat(): Uint8Array {
  const out = new Uint8Array(16 + 48);
  const v = new DataView(out.buffer);
  v.setUint32(4, 1); // 列数
  v.setUint32(12, 4); // 行サイズ
  v.setUint16(16 + 2, 452); // CHAR
  v.setUint32(16 + 4, 4); // 長さ
  v.setUint16(16 + 12, 37); // CCSID
  return out;
}

/** SQLCA（136 バイト）。`sqlCode` は 12 バイト目、`updateCount` は 104 */
function sqlca(sqlCode: number, updateCount = 1): Uint8Array {
  const out = new Uint8Array(136);
  const v = new DataView(out.buffer);
  v.setInt32(12, sqlCode);
  v.setInt32(104, updateCount);
  return out;
}

const okTemplate = { rcClass: 0, rcClassReturnCode: 0 };

/**
 * 応答を順に返す偽の接続。`request` の呼び出し順は
 * prepareAndDescribe → changeDescriptor → execute。
 */
function fakeConn(replies: { params: { cp: number; value: Uint8Array }[]; template?: object }[]) {
  let i = 0;
  return {
    request: vi.fn(async () => {
      const r = replies[Math.min(i++, replies.length - 1)]!;
      return { params: r.params, dbTemplate: { ...okTemplate, ...(r.template ?? {}) } };
    })
  } as unknown as DbConnection;
}

const PREPARE_OK = { params: [{ cp: 0x3813, value: markerFormat() }, { cp: 0x3807, value: sqlca(0) }] };
const CHANGE_OK = { params: [{ cp: 0x3807, value: sqlca(0) }] };
const args = { library: "L", table: "T", columns: ["C"], rows: [["x"]] };

describe("成功", () => {
  it("SQLCA が 0 で更新件数が一致すれば通る", async () => {
    const conn = fakeConn([PREPARE_OK, CHANGE_OK, { params: [{ cp: 0x3807, value: sqlca(0, 1) }] }]);
    const res = await insertRows(conn, args);
    expect(res.committedRows).toBe(1);
    expect(res.uncertainRange).toBeUndefined();
  });

  it("**3 段を順に送る**（準備 → 形式の登録 → 実行）", async () => {
    const conn = fakeConn([PREPARE_OK, CHANGE_OK, { params: [{ cp: 0x3807, value: sqlca(0, 1) }] }]);
    await insertRows(conn, args);
    const calls = (conn.request as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0].reqId);
    expect(calls).toEqual([0x1803, 0x1e00, 0x1805]);
  });

  it("**マーカーのハンドルは RPB ハンドルとは別欄に載せる**", async () => {
    const conn = fakeConn([PREPARE_OK, CHANGE_OK, { params: [{ cp: 0x3807, value: sqlca(0, 1) }] }]);
    await insertRows(conn, args);
    const calls = (conn.request as ReturnType<typeof vi.fn>).mock.calls;
    // 登録と実行はマーカーのハンドルを指定する（準備は不要）
    expect(calls[1]![0].parameterMarkerHandle).toBeGreaterThan(0);
    expect(calls[2]![0].parameterMarkerHandle).toBe(calls[1]![0].parameterMarkerHandle);
  });

  it("**診断ビットを常に立てる**（立てないと失敗が沈黙する）", async () => {
    const conn = fakeConn([PREPARE_OK, CHANGE_OK, { params: [{ cp: 0x3807, value: sqlca(0, 1) }] }]);
    await insertRows(conn, args);
    for (const c of (conn.request as ReturnType<typeof vi.fn>).mock.calls) {
      expect(c[0].orsBitmap & 0x40000000).toBeTruthy(); // messageId
      expect(c[0].orsBitmap & 0x20000000).toBeTruthy(); // firstLevelText
      expect(c[0].orsBitmap & 0x02000000).toBeTruthy(); // sqlca
    }
  });
});

describe("失敗の検出", () => {
  it("SQLCODE が負なら失敗（理由を添える）", async () => {
    const conn = fakeConn([
      PREPARE_OK,
      CHANGE_OK,
      { params: [{ cp: 0x3807, value: sqlca(-204) }] }
    ]);
    const res = await insertRows(conn, args);
    expect(res.uncertainRange).toEqual({ from: 1, to: 1 });
    expect(res.error).toMatch(/SQLCODE=-204/);
  });

  it("**template のエラーを見逃さない**（allowTemplateError で抑止しているため）", async () => {
    const conn = fakeConn([
      PREPARE_OK,
      CHANGE_OK,
      { params: [{ cp: 0x3807, value: sqlca(0) }], template: { rcClass: 7, rcClassReturnCode: 3 } }
    ]);
    const res = await insertRows(conn, args);
    expect(res.uncertainRange).toBeDefined();
    expect(res.error).toMatch(/rcClass=7/);
  });

  it("**SQLCA が無い応答を成功にしない**（判定できないものは失敗扱い）", async () => {
    const conn = fakeConn([PREPARE_OK, CHANGE_OK, { params: [] }]);
    const res = await insertRows(conn, args);
    expect(res.uncertainRange).toBeDefined();
    expect(res.error).toMatch(/判定できません/);
  });

  it("**更新件数が送った件数と違えば失敗**", async () => {
    const conn = fakeConn([PREPARE_OK, CHANGE_OK, { params: [{ cp: 0x3807, value: sqlca(0, 0) }] }]);
    const res = await insertRows(conn, args);
    expect(res.uncertainRange).toBeDefined();
    expect(res.error).toMatch(/行数が一致しません/);
  });

  it("形式の登録が失敗したら実行へ進まない", async () => {
    const conn = fakeConn([
      PREPARE_OK,
      { params: [{ cp: 0x3807, value: sqlca(-901) }] }
    ]);
    await expect(insertRows(conn, args)).rejects.toThrow(/登録できませんでした/);
    // 実行（0x1805）まで到達していない
    const calls = (conn.request as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0].reqId);
    expect(calls).not.toContain(0x1805);
  });

  it("マーカー形式が返らなければ拒否する", async () => {
    const conn = fakeConn([{ params: [{ cp: 0x3807, value: sqlca(0) }] }]);
    await expect(insertRows(conn, args)).rejects.toThrow(/マーカー形式が返りません/);
  });

  it("列数とマーカー数が食い違えば拒否する", async () => {
    const conn = fakeConn([PREPARE_OK, CHANGE_OK]);
    await expect(insertRows(conn, { ...args, columns: ["C", "D"], rows: [["x", "y"]] })).rejects.toThrow(
      /マーカーの数が列数と一致しません/
    );
  });
});

describe("値を詰められない行", () => {
  it("**行番号つきで返す**（1 行も書かない）", async () => {
    const conn = fakeConn([PREPARE_OK, CHANGE_OK]);
    // CHAR(4) に 5 バイト
    await expect(insertRows(conn, { ...args, rows: [["ok"], ["toolong"]] })).rejects.toMatchObject({
      row: 2
    });
    const calls = (conn.request as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0].reqId);
    expect(calls).not.toContain(0x1805); // 送っていない
  });
});
