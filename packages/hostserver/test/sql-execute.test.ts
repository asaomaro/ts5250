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
    const res = await executeStatement(conn, "CREATE TABLE ASAOLIB.T (ID INT)");
    expect(res.warning).toEqual({ sqlCode: 7905, sqlState: "01567" });
    expect(res.updateCount).toBe(0);
  });

  it("prepare 段の警告では止まらない（execute まで進む）", async () => {
    const { conn, sent } = fakeConn([
      { params: [{ cp: CP_SQLCA, value: sqlca(7905, 0, "01567") }] },
      { params: [{ cp: CP_SQLCA, value: sqlca(0, 1) }] }
    ]);
    const res = await executeStatement(conn, "CREATE TABLE ASAOLIB.T (ID INT)");
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

describe("パラメータマーカー付きは断る（CALL を除く）", () => {
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

/**
 * **`CALL` の `?` だけは通す**。あれは値を書く場所ではなく**出力を受け取る場所**で、
 * 断ると手続きの OUT を画面から見る手段が無くなる（SR-OSAKA で経路を実測）。
 * DML の `?` を通さないのは従来どおり——値の無いまま NULL を書き込んでしまうため。
 */
describe("CALL の出力パラメーター", () => {
  const CP_MARKER_FORMAT_REPLY = 0x3813;
  const CP_EXT_RESULT_DATA = 0x380e;
  const REQ_CHANGE_DESCRIPTOR = 0x1e00;

  /** マーカー形式 1 つ（DECIMAL(7,2)、4 バイト）。ヘッダー 16 ＋ 記述子 48 */
  function markerFormat(): Uint8Array {
    const out = new Uint8Array(16 + 48);
    const v = new DataView(out.buffer);
    v.setUint32(4, 1); // 列数
    v.setUint32(12, 4); // 行サイズ
    const at = 16;
    v.setUint16(at + 0, 48); // 記述子長
    v.setUint16(at + 2, 485); // DECIMAL（NULL 可の +1 は付けない）
    v.setUint32(at + 4, 4); // バイト長
    v.setUint16(at + 8, 2); // 位取り
    v.setUint16(at + 10, 7); // 精度
    v.setUint16(at + 12, 0); // CCSID
    return out;
  }

  /** 実行後の応答に載る出力値（+17.00 を 4 バイトのパック 10 進で） */
  function outputRow(): Uint8Array {
    const out = new Uint8Array(20 + 2 + 4);
    const v = new DataView(out.buffer);
    v.setUint32(4, 1); // 行数
    v.setUint16(8, 1); // 列数
    v.setUint16(10, 2); // 指標サイズ
    v.setUint32(16, 4); // 行サイズ
    out.set([0x00, 0x01, 0x70, 0x0f], 22);
    return out;
  }

  const PREP_WITH_MARKER = {
    params: [
      { cp: CP_SQLCA, value: sqlca(0) },
      { cp: CP_MARKER_FORMAT_REPLY, value: markerFormat() }
    ]
  };
  const EXEC_WITH_OUTPUT = {
    params: [
      { cp: CP_SQLCA, value: sqlca(0) },
      { cp: CP_EXT_RESULT_DATA, value: outputRow() }
    ]
  };

  it("形式を登録してから実行し、出力値を返す", async () => {
    const { conn, sent } = fakeConn([PREP_WITH_MARKER, { params: [] }, EXEC_WITH_OUTPUT]);
    const res = await executeStatement(conn, "CALL P(1, 2.25, ?)");

    expect(sent.map((f) => f.reqId)).toEqual([
      REQ_PREPARE_AND_DESCRIBE,
      REQ_CHANGE_DESCRIPTOR,
      REQ_EXECUTE
    ]);
    expect(res.outputs).toEqual(["17.00"]);
  });

  /** 値は持たないので NULL を送る（どの位置が入力かは分からない。docstring の判断） */
  it("入力としては NULL を送る", async () => {
    const { conn, sent } = fakeConn([PREP_WITH_MARKER, { params: [] }, EXEC_WITH_OUTPUT]);
    await executeStatement(conn, "CALL P(1, 2.25, ?)");

    const data = sent[2]!.params.find((p) => p.cp === CP_MARKER_DATA)!;
    // 指標はヘッダー（20 バイト）の直後。0xFFFF が NULL
    const v = new DataView(data.value.buffer, data.value.byteOffset);
    expect(v.getUint16(20)).toBe(0xffff);
  });

  it("マーカーの無い CALL は今までどおり（形式の登録に行かない）", async () => {
    const { conn, sent } = fakeConn([
      { params: [{ cp: CP_SQLCA, value: sqlca(0) }, { cp: CP_MARKER_FORMAT_REPLY, value: new Uint8Array(0) }] },
      OK
    ]);
    const res = await executeStatement(conn, "CALL QSYS2.QCMDEXC('DSPLIBL')");
    expect(sent.map((f) => f.reqId)).toEqual([REQ_PREPARE_AND_DESCRIBE, REQ_EXECUTE]);
    expect(res.outputs).toBeUndefined();
  });

  /**
   * **出力が読めなくても実行は成功している。** ここで投げると
   * 「手続きは動いたのに失敗と表示される」ことになる。
   */
  it("出力を復号できなくても成功として返す", async () => {
    const { conn } = fakeConn([
      PREP_WITH_MARKER,
      { params: [] },
      { params: [{ cp: CP_SQLCA, value: sqlca(0) }, { cp: CP_EXT_RESULT_DATA, value: new Uint8Array(5) }] }
    ]);
    const res = await executeStatement(conn, "CALL P(?)");
    expect(res.hasRowCount).toBe(false);
    expect(res.outputs).toBeUndefined();
  });
});

/**
 * **ホストが言ったことを捨てない。** SQLCA が空になる失敗は実在する
 * （結果セットを返す手続きの CALL は `rcClass=2 / -403` ＋ SQLCA 0 バイト。SR-OSAKA で実測）。
 * 理由を落とすと「判定できません」しか出ず、利用者は原因に辿り着けない。
 */
describe("失敗の理由", () => {
  const CP_MESSAGE_ID = 0x3801;

  it("SQLCA が無いときはホストのメッセージと rcClass を添える", async () => {
    // メッセージ ID は CCSID(2) ＋ 本文（EBCDIC 37 の "PWS0011"）
    const id = Uint8Array.from([0x00, 0x25, 0xd7, 0xe6, 0xe2, 0xf0, 0xf0, 0xf1, 0xf1]);
    const request = vi.fn(async () => ({
      params: [{ cp: CP_MESSAGE_ID, value: id }],
      dbTemplate: { rcClass: 2, rcClassReturnCode: -403 }
    }));
    const conn = { request, acquire: () => () => {} } as unknown as DbConnection;
    const err = await executeStatement(conn, "CALL P()").catch((e: unknown) => e);
    expect(String((err as Error).message)).toContain("rcClass=2 rc=-403");
    expect(String((err as Error).message)).toContain("PWS0011");
  });
});

/**
 * **結果セットを返す手続きの `CALL`**（`SQLCODE +466`）。
 *
 * 実機（SR-OSAKA）で分かったこと:
 * - `execute` に**カーソル名を添えないと** `rcClass=2 / -403` で断られ、SQLCA すら返らない
 * - 添えると `+466`（結果セットが N 個）になり、そのカーソルから読める
 * - **読めるのは 1 個目だけ**（2 個目を開くと `-517`）。数は SQLERRMC の末尾に載る
 */
describe("CALL の結果セット", () => {
  const CP_CURSOR_NAME = 0x380b;
  const CP_DATA_FORMAT = 0x3805;
  const CP_EXT_RESULT_DATA = 0x380e;
  const REQ_OPEN_AND_DESCRIBE = 0x1804;
  const REQ_FETCH = 0x180b;
  const REQ_CLOSE = 0x180a;

  /** SQLCODE +466 の SQLCA。SQLERRMC は「名前・名前・数」（実機の並び） */
  function sqlca466(count: number): Uint8Array {
    const out = sqlca(466, 0, "0100C");
    const v = new DataView(out.buffer);
    const name = [0xd7, 0xf1]; // EBCDIC "P1"
    v.setUint16(16, 2 + name.length + 2 + name.length + 2); // SQLERRML
    let at = 18;
    for (let i = 0; i < 2; i++) {
      v.setUint16(at, name.length);
      out.set(name, at + 2);
      at += 2 + name.length;
    }
    v.setUint16(at, count);
    return out;
  }

  /** 列定義（元形式・INTEGER 1 列）。8 ＋ 54 バイト */
  function format1(): Uint8Array {
    const out = new Uint8Array(8 + 54);
    const v = new DataView(out.buffer);
    v.setUint16(4, 1); // 列数
    v.setUint16(6, 4); // レコード長
    v.setUint16(8 + 2, 496); // INTEGER
    v.setUint16(8 + 4, 4); // 長さ
    v.setUint16(8 + 20, 2); // 名前の長さ
    v.setUint16(8 + 22, 37); // 名前の CCSID
    out.set([0xc9, 0xc4], 8 + 24); // "ID"
    return out;
  }

  /** n 行（ID は 7, 8, …） */
  function rowsN(n: number): Uint8Array {
    const out = new Uint8Array(20 + 2 * n + 4 * n);
    const v = new DataView(out.buffer);
    v.setUint32(4, n);
    v.setUint16(8, 1);
    v.setUint16(10, 2);
    v.setUint32(16, 4);
    for (let i = 0; i < n; i++) v.setUint32(20 + 2 * n + 4 * i, 7 + i);
    return out;
  }

  function callConn(count = 1, rowCount = 1) {
    const sent: Frame[] = [];
    const request = vi.fn(async (frame: Frame) => {
      sent.push(frame);
      switch (frame.reqId) {
        case REQ_PREPARE_AND_DESCRIBE:
          return { params: [{ cp: CP_SQLCA, value: sqlca(0) }], dbTemplate: okTemplate };
        case REQ_EXECUTE:
          return { params: [{ cp: CP_SQLCA, value: sqlca466(count) }], dbTemplate: okTemplate };
        case REQ_OPEN_AND_DESCRIBE:
          return {
            params: [{ cp: CP_DATA_FORMAT, value: format1() }, { cp: CP_SQLCA, value: sqlca(0) }],
            dbTemplate: okTemplate
          };
        case REQ_FETCH: {
          // 2 回目は「もう無い」（SQLCODE 100）
          const fetched = sent.filter((f) => f.reqId === REQ_FETCH).length;
          return {
            params: [
              { cp: CP_EXT_RESULT_DATA, value: fetched === 1 ? rowsN(rowCount) : new Uint8Array(0) },
              { cp: CP_SQLCA, value: sqlca(fetched === 1 ? 0 : 100) }
            ],
            dbTemplate: okTemplate
          };
        }
        default:
          return { params: [{ cp: CP_SQLCA, value: sqlca(0) }], dbTemplate: okTemplate };
      }
    });
    const conn = { request, acquire: () => () => {} } as unknown as DbConnection;
    return { conn, sent };
  }

  it("**CALL にはカーソル名を添える**（添えないとホストが -403 で断る）", async () => {
    const { conn, sent } = callConn();
    await executeStatement(conn, "CALL P()");
    const exec = sent.find((f) => f.reqId === REQ_EXECUTE)!;
    expect(exec.params.map((p) => p.cp)).toContain(CP_CURSOR_NAME);
  });

  it("CALL 以外にはカーソル名を添えない（今までの経路を変えない）", async () => {
    const { conn, sent } = fakeConn([OK, OK]);
    await executeStatement(conn, "DELETE FROM QTEMP.T");
    for (const f of sent) expect(f.params.map((p) => p.cp)).not.toContain(CP_CURSOR_NAME);
  });

  it("開いて読んで閉じる。行と列を返す", async () => {
    const { conn, sent } = callConn();
    const res = await executeStatement(conn, "CALL P()");
    expect(sent.map((f) => f.reqId)).toContain(REQ_OPEN_AND_DESCRIBE);
    expect(sent.map((f) => f.reqId)).toContain(REQ_CLOSE);
    expect(res.resultSet?.columns.map((c) => c.name)).toEqual(["ID"]);
    expect(res.resultSet?.rows).toEqual([{ ID: 7 }]);
    expect(res.resultSets).toBe(1);
  });

  /** **+466 は警告ではない**（結果セットがあるという知らせ）。警告として出すと嘘になる */
  it("+466 を警告として返さない", async () => {
    const { conn } = callConn();
    const res = await executeStatement(conn, "CALL P()");
    expect(res.warning).toBeUndefined();
  });

  it("結果セットが 2 個以上あることを伝える（1 個目しか出せないので黙らない）", async () => {
    const { conn } = callConn(2);
    const res = await executeStatement(conn, "CALL P()");
    expect(res.resultSets).toBe(2);
  });

  /** **切ったことを黙らない**（続きは取りに行けないので、言わないと「全部見た」に見える） */
  it("上限で切ったら truncated を立てる", async () => {
    const cut = await executeStatement(callConn(1, 3).conn, "CALL P()", { resultLimit: 2 });
    expect(cut.resultSet?.rows).toHaveLength(2);
    expect(cut.resultSet?.truncated).toBe(true);

    const whole = await executeStatement(callConn(1, 2).conn, "CALL P()", { resultLimit: 2 });
    expect(whole.resultSet?.rows).toHaveLength(2);
    expect(whole.resultSet?.truncated).toBe(false);
  });
});
