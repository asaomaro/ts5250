import { describe, it, expect, vi } from "vitest";
import { openQuery } from "../src/db/query.js";
import { DbConnection } from "../src/db/db-connection.js";

/**
 * `openQuery` の解放漏れ回帰。
 *
 * `20260802-sql-visual-explain` の research F9: 返したジェネレータを**1 度も回さずに**
 * `return()` すると `iterate()` の `finally` が走らず（本体が開始していないため）、
 * カーソルも接続の占有も解放されなかった。実測では以降その接続のすべての要求が
 * `another query is in progress` になった。
 *
 * 「行を返さずに計画だけ取る」モードがまさにこの経路を通るので、
 * **冪等な `close()` で必ず解放される**ことをここで固定する。
 */

const CP_SQLCA = 0x3807;
const CP_SUPER_EXTENDED_FORMAT = 0x3812;
const REQ_CLOSE_CURSOR = 0x180a;

/** SQLCA（136 バイト）。成功（SQLCODE 0） */
function sqlcaOk(): Uint8Array {
  const out = new Uint8Array(136);
  // SQLSTATE "00000" を EBCDIC の数字で
  for (let i = 0; i < 5; i++) out[131 + i] = 0xf0;
  return out;
}

/** 列 1 つ（CHAR(4)）の超拡張データ形式 */
function oneColumnFormat(): Uint8Array {
  const out = new Uint8Array(16 + 48);
  const v = new DataView(out.buffer);
  v.setUint32(4, 1); // 列数
  v.setUint32(12, 4); // レコードサイズ
  const col = new DataView(out.buffer, 16, 48);
  col.setUint16(2, 452); // CHAR
  col.setUint32(4, 4); // 長さ
  col.setUint16(12, 273); // CCSID
  return out;
}

/**
 * prepare → open → （fetch）→ closeCursor を受ける偽の接続。
 * 占有の解放は本物の `DbConnection.acquire` で確かめる（そこが壊れると意味が無い）。
 */
function fakeConn() {
  const conn = Object.create(DbConnection.prototype) as DbConnection;
  const sent: number[] = [];
  const request = vi.fn(async (frame: { reqId: number }) => {
    sent.push(frame.reqId);
    return {
      params: [
        { cp: CP_SQLCA, value: sqlcaOk() },
        { cp: CP_SUPER_EXTENDED_FORMAT, value: oneColumnFormat() }
      ],
      dbTemplate: { rcClass: 0, rcClassReturnCode: 0 }
    };
  });
  (conn as unknown as { request: unknown }).request = request;
  return { conn, sent };
}

describe("openQuery の解放", () => {
  it("1 行も読まずに close() すればカーソルが閉じられ、次の問い合わせを開始できる", async () => {
    const { conn, sent } = fakeConn();
    const opened = await openQuery(conn, "SELECT C FROM QTEMP.T");

    // close する前は占有されている（＝この時点で解放されていたら検査にならない）
    expect(() => conn.acquire()).toThrow(/another query is in progress/);

    await opened.close();

    expect(sent).toContain(REQ_CLOSE_CURSOR);
    expect(() => conn.acquire()).not.toThrow();
  });

  it("close() は冪等（複数回呼んでもカーソルを 2 度閉じない）", async () => {
    const { conn, sent } = fakeConn();
    const opened = await openQuery(conn, "SELECT C FROM QTEMP.T");

    await opened.close();
    await opened.close();
    await opened.close();

    expect(sent.filter((r) => r === REQ_CLOSE_CURSOR)).toHaveLength(1);
  });

  it("ジェネレータを回さずに return() したあと close() しても解放される", async () => {
    const { conn } = fakeConn();
    const opened = await openQuery(conn, "SELECT C FROM QTEMP.T");

    // **これだけでは解放されない**（F9 の元の症状）。close() が要る
    await opened.rows.return(undefined);
    await opened.close();

    expect(() => conn.acquire()).not.toThrow();
  });

  it("列定義は close() の前に読める（no-rows モードはこれだけを使う）", async () => {
    const { conn } = fakeConn();
    const opened = await openQuery(conn, "SELECT C FROM QTEMP.T");
    expect(opened.columns).toHaveLength(1);
    await opened.close();
  });
});
