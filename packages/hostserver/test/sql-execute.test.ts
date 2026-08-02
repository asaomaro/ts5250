import { describe, it, expect, vi } from "vitest";
import { executeStatement } from "../src/db/execute.js";
import { SqlError } from "../src/db/query.js";
import { As400Error } from "@ts5250/base";
import type { DbConnection } from "../src/db/db-connection.js";

/**
 * 結果を返さない文の実行。**書き込みは取り消せない**ので、
 * 「成功と言い切れないものを成功にしない」ことをここで固定する
 * （`20260730-sql-non-query-statements` spec 方針3）。
 *
 * 実機の値は research F5 で測ったもの: `0`＝成功、`01504`/`7905`＝警告つき成功、
 * `-104`/`-204`＝失敗（prepare 段）、`-518`＝経路違い（execute 段）。
 */

/** SQLCA（136 バイト）。`sqlCode` は 12、`updateCount` は 104、`sqlState` は 131 */
function sqlca(sqlCode: number, updateCount = 0, sqlState = "00000"): Uint8Array {
  const out = new Uint8Array(136);
  const v = new DataView(out.buffer);
  v.setInt32(12, sqlCode);
  v.setInt32(104, updateCount);
  // SQLSTATE は EBCDIC の数字（0xF0-0xF9）と英大文字。ここは数字だけで足りる
  for (let i = 0; i < 5; i++) {
    const ch = sqlState.charCodeAt(i);
    out[131 + i] = ch >= 0x30 && ch <= 0x39 ? 0xf0 + (ch - 0x30) : 0x40;
  }
  return out;
}

const CP_SQLCA = 0x3807;
const okTemplate = { rcClass: 0, rcClassReturnCode: 0 };

type Frame = { reqId: number; params: readonly { cp: number; value: Uint8Array }[]; orsBitmap?: number };

/** 応答を順に返す偽の接続。呼び出し順は prepareAndDescribe → execute */
function fakeConn(replies: { params: { cp: number; value: Uint8Array }[] }[]) {
  const sent: Frame[] = [];
  let released = 0;
  const request = vi.fn(async (frame: Frame) => {
    sent.push(frame);
    const r = replies[Math.min(sent.length - 1, replies.length - 1)]!;
    return { params: r.params, dbTemplate: okTemplate };
  });
  const conn = {
    request,
    acquire: () => () => {
      released += 1;
    }
  } as unknown as DbConnection;
  return { conn, sent, releases: () => released };
}

const REQ_PREPARE_AND_DESCRIBE = 0x1803;
const REQ_EXECUTE = 0x1805;
/** マーカーの登録・受け渡し。**この経路では 1 つも載せない** */
const CP_MARKER_FORMAT_REQ = 0x381e;
const CP_MARKER_DATA = 0x381f;

const OK = { params: [{ cp: CP_SQLCA, value: sqlca(0) }] };

describe("要求の形", () => {
  it("prepareAndDescribe → execute の 2 要求で、マーカーは 1 つも載せない", async () => {
    const { conn, sent } = fakeConn([OK, OK]);
    await executeStatement(conn, "DELETE FROM QTEMP.T");

    expect(sent.map((f) => f.reqId)).toEqual([REQ_PREPARE_AND_DESCRIBE, REQ_EXECUTE]);
    for (const f of sent) {
      const cps = f.params.map((p) => p.cp);
      expect(cps).not.toContain(CP_MARKER_FORMAT_REQ);
      expect(cps).not.toContain(CP_MARKER_DATA);
    }
  });

  it("文型 1 を送る（research F4。実機で DML も DDL も通った値）", async () => {
    const { conn, sent } = fakeConn([OK, OK]);
    await executeStatement(conn, "CREATE TABLE QTEMP.T (ID INT)");

    for (const f of sent) {
      const type = f.params.find((p) => p.cp === 0x3812);
      expect(type).toBeDefined();
      expect(new DataView(type!.value.buffer, type!.value.byteOffset).getUint16(0)).toBe(1);
    }
  });

  it("文名は insert.ts（ASUPLOAD）と別（同じ RPB で踏み合わないため）", async () => {
    const { conn, sent } = fakeConn([OK, OK]);
    await executeStatement(conn, "DELETE FROM QTEMP.T");

    const name = sent[0]!.params.find((p) => p.cp === 0x3806)!;
    // CCSID(2) ＋ 長さ(2) ＋ EBCDIC の文名
    expect(new DataView(name.value.buffer, name.value.byteOffset).getUint16(0)).toBe(37);
    const text = Buffer.from(name.value.slice(4)).toString("latin1");
    expect(text).not.toBe("ASUPLOAD");
    // execute 側も同じ文名を指す（別名だと「準備していない文」を実行しに行く）
    const name2 = sent[1]!.params.find((p) => p.cp === 0x3806)!;
    expect(Buffer.from(name2.value.slice(4)).toString("latin1")).toBe(text);
  });

  it("文テキストは CCSID 13488（UTF-16BE）で、日本語もそのまま載る", async () => {
    const { conn, sent } = fakeConn([OK, OK]);
    await executeStatement(conn, "UPDATE T SET S = '日本'");

    const sql = sent[0]!.params.find((p) => p.cp === 0x3807)!;
    const v = new DataView(sql.value.buffer, sql.value.byteOffset);
    expect(v.getUint16(0)).toBe(13488);
    expect(v.getUint16(2)).toBe("UPDATE T SET S = '日本'".length * 2);
    expect(Buffer.from(sql.value.slice(4)).toString("utf16le").length).toBeGreaterThan(0);
    // 末尾 2 文字が「日本」（UTF-16BE で並んでいる）
    const chars = [];
    for (let i = 4; i < sql.value.length; i += 2) chars.push(String.fromCharCode(v.getUint16(i)));
    expect(chars.join("")).toBe("UPDATE T SET S = '日本'");
  });

  it("SQLCA を必ず要求する（立てないと失敗の理由が分からない）", async () => {
    const { conn, sent } = fakeConn([OK, OK]);
    await executeStatement(conn, "DELETE FROM QTEMP.T");
    for (const f of sent) expect(f.orsBitmap! & 0x02000000).toBeTruthy();
  });

  it("実行区間を占有し、終わったら解放する", async () => {
    const { conn, releases } = fakeConn([OK, OK]);
    await executeStatement(conn, "DELETE FROM QTEMP.T");
    expect(releases()).toBe(1);
  });

  it("失敗しても解放する（占有したままにしない）", async () => {
    const { conn, releases } = fakeConn([{ params: [{ cp: CP_SQLCA, value: sqlca(-204, 0, "42704") }] }]);
    await expect(executeStatement(conn, "DELETE FROM QTEMP.NOSUCH")).rejects.toThrow(SqlError);
    expect(releases()).toBe(1);
  });
});

describe("成否の判定", () => {
  it("SQLCODE 0 は成功。影響行数を返す", async () => {
    const { conn } = fakeConn([OK, { params: [{ cp: CP_SQLCA, value: sqlca(0, 2) }] }]);
    const res = await executeStatement(conn, "UPDATE QTEMP.T SET S = 'z'");
    expect(res).toEqual({ updateCount: 2, hasRowCount: true });
  });

  it("正の SQLCODE は警告つき成功（7905 = 表は作られた。research F6）", async () => {
    const { conn } = fakeConn([OK, { params: [{ cp: CP_SQLCA, value: sqlca(7905, 0, "01567") }] }]);
    const res = await executeStatement(conn, "CREATE TABLE TESTLIB.T (ID INT)");
    expect(res.warning).toEqual({ sqlCode: 7905, sqlState: "01567" });
    expect(res.updateCount).toBe(0);
  });

  it("prepare 段の警告では止まらない（execute まで進む）", async () => {
    const { conn, sent } = fakeConn([
      { params: [{ cp: CP_SQLCA, value: sqlca(7905, 0, "01567") }] },
      { params: [{ cp: CP_SQLCA, value: sqlca(0, 1) }] }
    ]);
    const res = await executeStatement(conn, "CREATE TABLE TESTLIB.T (ID INT)");
    expect(sent).toHaveLength(2);
    expect(res.updateCount).toBe(1);
  });

  it("負の SQLCODE は失敗。SQLCODE と SQLSTATE を伝える", async () => {
    const { conn } = fakeConn([{ params: [{ cp: CP_SQLCA, value: sqlca(-104, 0, "42601") }] }]);
    const err = await executeStatement(conn, "UPDATE QTEMP.T SET").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SqlError);
    expect((err as SqlError).sqlCode).toBe(-104);
    expect((err as SqlError).sqlState).toBe("42601");
  });

  it("prepare が失敗したら execute を呼ばない（存在しない表で書きに行かない）", async () => {
    const { conn, sent } = fakeConn([{ params: [{ cp: CP_SQLCA, value: sqlca(-204, 0, "42704") }] }]);
    await expect(executeStatement(conn, "DELETE FROM QTEMP.NOSUCH")).rejects.toThrow(SqlError);
    expect(sent).toHaveLength(1);
  });

  it("execute の -518（経路違い）も失敗として伝える", async () => {
    const { conn } = fakeConn([OK, { params: [{ cp: CP_SQLCA, value: sqlca(-518, 0, "07003") }] }]);
    const err = await executeStatement(conn, "SELECT * FROM QTEMP.T").catch((e: unknown) => e);
    expect((err as SqlError).sqlCode).toBe(-518);
  });

  it("SQLCA が無い応答は失敗（書き込みは取り消せないので成功にしない）", async () => {
    const { conn } = fakeConn([OK, { params: [] }]);
    const err = await executeStatement(conn, "DELETE FROM QTEMP.T").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(As400Error);
    expect((err as As400Error).code).toBe("PROTOCOL_ERROR");
  });

  /**
   * **ここは実機の値でしか決められない。** DDL も `updateCount: 0` で返る（research F3）ので、
   * 件数から「行数の意味」を決めると DDL に「0 行に影響しました」と出てしまう。
   */
  it("DDL は同じ 0 でも hasRowCount が false（DML の 0 行と混ぜない）", async () => {
    const ddl = fakeConn([OK, { params: [{ cp: CP_SQLCA, value: sqlca(0, 0) }] }]);
    expect(await executeStatement(ddl.conn, "DROP TABLE QTEMP.T")).toEqual({
      updateCount: 0,
      hasRowCount: false
    });

    const dml = fakeConn([OK, { params: [{ cp: CP_SQLCA, value: sqlca(0, 0) }] }]);
    expect(await executeStatement(dml.conn, "DELETE FROM QTEMP.T WHERE 1 = 0")).toEqual({
      updateCount: 0,
      hasRowCount: true
    });
  });

  it("行数が負で返っても 0 にそろえる（負の件数を画面に出さない）", async () => {
    const { conn } = fakeConn([OK, { params: [{ cp: CP_SQLCA, value: sqlca(0, -1) }] }]);
    const res = await executeStatement(conn, "DELETE FROM QTEMP.T");
    expect(res.updateCount).toBe(0);
  });
});

describe("パラメータマーカー付きは断る", () => {
  it("? を含む文は実行前に断る（埋める道が無いまま実行させない）", async () => {
    const { conn, sent } = fakeConn([OK, OK]);
    const err = await executeStatement(conn, "DELETE FROM T WHERE ID = ?").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(As400Error);
    expect((err as As400Error).code).toBe("CONFIG_ERROR");
    // **1 つも送っていない**（送ってから断るのでは遅い）
    expect(sent).toHaveLength(0);
  });

  it("文字列リテラルの中の ? は断らない", async () => {
    const { conn } = fakeConn([OK, OK]);
    await expect(executeStatement(conn, "UPDATE T SET S = '?'")).resolves.toBeDefined();
  });
});
