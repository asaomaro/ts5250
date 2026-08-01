import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "../src/app.js";
import { SessionManager } from "../src/session-manager.js";
import { ConfigResolver } from "../src/config-resolver.js";
import { PersonalConfigStore, ServerConfigStore } from "../src/config-store.js";
import { AuditBuffer } from "../src/audit.js";
import { DbPool, poolKey } from "../src/db-pool.js";
import { SqlError, type DbConnection } from "@as400web/hostserver";
import { codecForCcsid } from "@as400web/ebcdic";

/**
 * `/api/host/sql` の振り分け（クエリ / 非クエリ）。
 *
 * 実際の実行は実機でしか確かめられないが、**振り分けと応答の形**はここで固定できる。
 * ここが崩れると「SELECT を書いたのに `-518` で落ちる」「DDL が黙って成功に見える」
 * といった、利用者に理由が分からない壊れ方をする。
 *
 * 偽の接続を**プールに置いてから**要求する（`acquire` が待機中を拾うので、
 * 実機へ繋ぎに行かない）。
 */

/** 環境変数からパスワードを取る形にする。**実資格情報は使わない**（ダミー） */
const PW_ENV = "TEST_HOST_SQL_EXEC_PW";
const DUMMY_PW = "dummy-not-a-real-password";
const HOST = "example.invalid";
const USER = "TESTUSR";

/** SQLCA（136 バイト）。`sqlCode` は 12、`updateCount` は 104、`sqlState` は 131 */
function sqlca(sqlCode: number, updateCount = 0, sqlState = "00000"): Uint8Array {
  const out = new Uint8Array(136);
  const v = new DataView(out.buffer);
  v.setInt32(12, sqlCode);
  v.setInt32(104, updateCount);
  for (let i = 0; i < 5; i++) {
    const ch = sqlState.charCodeAt(i);
    out[131 + i] = ch >= 0x30 && ch <= 0x39 ? 0xf0 + (ch - 0x30) : 0x40;
  }
  return out;
}

const CP_SQLCA = 0x3807;

/** 文名の CP。**どちらの経路を通ったか**はこれで見分ける（クエリ=`S1` / 非クエリ=`ASEXEC`） */
const CP_STATEMENT_NAME = 0x3806;

interface Frame {
  reqId: number;
  params: readonly { cp: number; value: Uint8Array }[];
}

interface Fake {
  conn: DbConnection;
  sent: Frame[];
  /** 送った文名（EBCDIC を戻したもの） */
  names: string[];
  closed: () => boolean;
}

/**
 * 偽の database 接続。`request` は SQLCA だけを返す。
 *
 * `stopWith` を渡すと**最初の要求でその誤りを投げる**——クエリ経路の検証に使う。
 * `SqlError` は「相手は生きていて SQL が誤っていた」印なので、
 * サーバーは接続を張り直さない（張り直すと実機へ繋ぎに行ってテストが止まる）。
 */
function fakeConn(replies: Uint8Array[], stopWith?: Error): Fake {
  const sent: Frame[] = [];
  const names: string[] = [];
  let closed = false;
  const conn = {
    host: HOST,
    port: 8471,
    jobName: "123456/QUSER/QZDASOINIT",
    isClosed: false,
    acquire: () => () => undefined,
    close: () => {
      closed = true;
    },
    request: async (frame: Frame) => {
      sent.push(frame);
      const name = frame.params.find((p) => p.cp === CP_STATEMENT_NAME);
      if (name) names.push(codecForCcsid(37).decode(name.value.slice(4)));
      if (stopWith) throw stopWith;
      const value = replies[Math.min(sent.length - 1, replies.length - 1)] ?? sqlca(0);
      return { params: [{ cp: CP_SQLCA, value }], dbTemplate: { rcClass: 0, rcClassReturnCode: 0 } };
    }
  } as unknown as DbConnection;
  return { conn, sent, names, closed: () => closed };
}

/** 偽の接続を待機させたアプリ。要求はその接続に流れる */
function appWith(fake: Fake) {
  const pool = new DbPool();
  pool.release(poolKey(undefined, { host: HOST, user: USER, password: DUMMY_PW }), fake.conn);
  const server = new ServerConfigStore({
    systems: [{ id: "s", name: "s", host: HOST, signon: { user: USER, passwordEnv: PW_ENV } }],
    sessions: []
  });
  const app = buildApp({
    sessions: new SessionManager(),
    resolver: new ConfigResolver(server, new PersonalConfigStore({ systems: [], sessions: [] })),
    audit: new AuditBuffer(),
    version: "test",
    pool
  });
  return {
    pool,
    post: (sql: string) =>
      app.request("/api/host/sql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: { system: "srv:s" }, sql, pageSize: 200 })
      })
  };
}

beforeAll(() => {
  process.env[PW_ENV] = DUMMY_PW;
});
afterAll(() => {
  delete process.env[PW_ENV];
});

describe("非クエリ文の実行", () => {
  it("DML は kind: \"execute\" と影響行数を返す", async () => {
    const fake = fakeConn([sqlca(0), sqlca(0, 3)]);
    const res = await appWith(fake).post("DELETE FROM QTEMP.T WHERE ID > 0");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.kind).toBe("execute");
    expect(body.updateCount).toBe(3);
    expect(body.hasRowCount).toBe(true);
    // 接続の素性は既存の応答と同じ形で添える（障害切り分けのため）
    expect(body.connection.job).toBe("123456/QUSER/QZDASOINIT");
    expect(body.connection.reused).toBe(true);
    // prepareAndDescribe → execute の 2 往復
    expect(fake.sent.map((f) => f.reqId)).toEqual([0x1803, 0x1805]);
  });

  it("DDL は hasRowCount が false（「0 行に影響しました」と出さない）", async () => {
    const fake = fakeConn([sqlca(0), sqlca(0, 0)]);
    const body = await (await appWith(fake).post("CREATE TABLE QTEMP.T (ID INT)")).json();
    expect(body.kind).toBe("execute");
    expect(body.hasRowCount).toBe(false);
  });

  it("警告つき成功は warning を添えて 200（表は作られたのに黙るのを防ぐ）", async () => {
    const fake = fakeConn([sqlca(0), sqlca(7905, 0, "01567")]);
    const res = await appWith(fake).post("CREATE TABLE TESTLIB.T (ID INT)");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.warning).toEqual({ sqlCode: 7905, sqlState: "01567" });
  });

  it("成功した接続はプールへ返す（次の実行を 6 秒待たせない）", async () => {
    const fake = fakeConn([sqlca(0), sqlca(0, 1)]);
    const { pool, post } = appWith(fake);
    await post("INSERT INTO QTEMP.T VALUES(1)");
    expect(pool.idleSize).toBe(1);
    expect(fake.closed()).toBe(false);
  });
});

describe("失敗の扱い", () => {
  it("SQLCODE が負なら 400 で SQLCODE / SQLSTATE を返す", async () => {
    const fake = fakeConn([sqlca(-204, 0, "42704")]);
    const res = await appWith(fake).post("DELETE FROM QTEMP.NOSUCH");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("SQL_ERROR");
    expect(body.sqlCode).toBe(-204);
    expect(body.sqlState).toBe("42704");
  });

  it("SQL の誤りでは接続を捨てない（誤字のたびに 6 秒待たせない）", async () => {
    const fake = fakeConn([sqlca(-104, 0, "42601")]);
    const { pool, post } = appWith(fake);
    await post("UPDATE QTEMP.T SET");
    expect(pool.idleSize).toBe(1);
    expect(fake.closed()).toBe(false);
  });

  it("SQLCA が読めない応答は失敗（書き込みを黙って成功にしない）。接続は捨てる", async () => {
    const fake = fakeConn([]);
    // SQLCA を返さない偽接続
    const conn = fake.conn as unknown as { request: unknown };
    conn.request = async () => ({ params: [], dbTemplate: { rcClass: 0, rcClassReturnCode: 0 } });
    const { pool, post } = appWith(fake);
    const res = await post("DELETE FROM QTEMP.T");
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe("PROTOCOL_ERROR");
    // 状態が分からない接続は使い回さない
    expect(pool.idleSize).toBe(0);
    expect(fake.closed()).toBe(true);
  });

  /**
   * **資格情報を持たない設定**でも理由の分かる 400 を返す。
   * 接続先の解決を try の外に置いていたときは 500（Internal Server Error）になり、
   * 「ユーザーとパスワードが未登録」を伝えられなかった（既存テストが検出した）。
   */
  it("資格情報が無い設定は 400 CONFIG_ERROR（500 にしない）", async () => {
    const server = new ServerConfigStore({
      systems: [{ id: "noauth", name: "noauth", host: HOST }],
      sessions: []
    });
    const app = buildApp({
      sessions: new SessionManager(),
      resolver: new ConfigResolver(server, new PersonalConfigStore({ systems: [], sessions: [] })),
      audit: new AuditBuffer(),
      version: "test"
    });
    const res = await app.request("/api/host/sql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: { system: "srv:noauth" }, sql: "DELETE FROM QTEMP.T" })
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("CONFIG_ERROR");
    expect(body.error).toMatch(/ユーザーとパスワード/);
  });

  it("パラメータマーカー付きは 400 で断り、1 度も要求を送らない", async () => {
    const fake = fakeConn([sqlca(0), sqlca(0)]);
    const res = await appWith(fake).post("DELETE FROM QTEMP.T WHERE ID = ?");
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("CONFIG_ERROR");
    expect(fake.sent).toHaveLength(0);
  });
});

/**
 * **どちらの経路を通ったかを文名で見分ける。** クエリ経路（`query.ts`）は `S1`、
 * 非クエリ経路（`execute.ts`）は `ASEXEC` を使う。
 * 応答の形（`kind`）だけで見ると「クエリ経路が別の理由で落ちた」場合と区別できない。
 */
describe("振り分け", () => {
  const stop = new SqlError(-999, "XXXXX", "テスト用に止める");

  async function routeOf(sql: string): Promise<{ name: string | undefined; kind: unknown }> {
    const fake = fakeConn([], stop);
    const body = await (await appWith(fake).post(sql)).json();
    return { name: fake.names[0], kind: body.kind };
  }

  it("SELECT はクエリ経路（勝手に -518 で落とさない）", async () => {
    expect(await routeOf("SELECT * FROM QTEMP.T")).toEqual({ name: "S1", kind: undefined });
  });

  it("先頭のコメント付き SELECT もクエリ経路（コメントで判定を誤らせない）", async () => {
    expect((await routeOf("-- 数える\nSELECT COUNT(*) FROM QTEMP.T")).name).toBe("S1");
  });

  it("WITH 句もクエリ経路", async () => {
    const sql = "WITH t AS (SELECT 1 AS N FROM SYSIBM.SYSDUMMY1) SELECT N FROM t";
    expect((await routeOf(sql)).name).toBe("S1");
  });

  it("括弧始まりの和集合もクエリ経路", async () => {
    const sql = "(SELECT 1 FROM SYSIBM.SYSDUMMY1) UNION (SELECT 2 FROM SYSIBM.SYSDUMMY1)";
    expect((await routeOf(sql)).name).toBe("S1");
  });

  it("DELETE は非クエリ経路（文名が別＝insert.ts と踏み合わない）", async () => {
    expect((await routeOf("DELETE FROM QTEMP.T")).name).toBe("ASEXEC");
  });
});
