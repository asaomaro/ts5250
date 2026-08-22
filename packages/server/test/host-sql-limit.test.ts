import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { DbConnection } from "@ts5250/hostserver";

/**
 * **単発経路は毎回 `openDb` で接続を開く**ので、偽の接続はここで差し込む
 * （プールに置く手は使えない）。他の入口（コマンド・IFS 等）は本物のまま残す。
 */
const openDbMock = vi.fn();
vi.mock("../src/host-connect.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/host-connect.js")>();
  return { ...actual, openDb: (...a: unknown[]) => openDbMock(...a) };
});

// **テスト本体の中で import しない**（変換コストが it のタイムアウトに算入される）
const { buildApp } = await import("../src/app.js");
const { SessionManager } = await import("../src/session-manager.js");
const { ConfigResolver } = await import("../src/config-resolver.js");
const { PersonalConfigStore, ServerConfigStore } = await import("../src/config-store.js");
const { AuditBuffer } = await import("../src/audit.js");
const { DbPool, poolKey } = await import("../src/db-pool.js");
const { registerHostServerTools } = await import("../src/host-server-tools.js");

/**
 * `/api/host/sql`（単発経路）の**取得量の上限**。
 *
 * 見たいのは「応答の行数が合っている」ことではない（それは以前も合っていた）。
 * **ホストへ要求したブロッキング係数の合計**＝取ってきた行数が上限に収まっているかを見る。
 * ここが崩れると、大きな表で全行がメモリに載る（20,000 行で 1.2MB / 2.1 秒。
 * `20260730-sql-fetch-limit` research F2）。
 */

const PW_ENV = "TEST_HOST_SQL_LIMIT_PW";
const DUMMY_PW = "dummy-not-a-real-password";
const HOST = "example.invalid";
const USER = "TESTUSR";

const CP_SQLCA = 0x3807;
const CP_SUPER_EXT_FORMAT = 0x3812;
const CP_EXT_RESULT = 0x380e;
const CP_BLOCKING_FACTOR = 0x380c;
const REQ = { prepareAndDescribe: 0x1803, openAndDescribe: 0x1804, fetch: 0x180b, closeCursor: 0x180a };

function sqlca(sqlCode = 0): Uint8Array {
  const out = new Uint8Array(136);
  new DataView(out.buffer).setInt32(12, sqlCode);
  return out;
}

/** 超拡張列定義（`INTEGER` 1 列・列名 ID） */
function format1Int(): Uint8Array {
  const FIXED = 16;
  const REPEAT = 48;
  const name = new Uint8Array([0xc9, 0xc4]); // EBCDIC(37) の "ID"
  const varLen = 8 + name.length;
  const out = new Uint8Array(FIXED + REPEAT + varLen);
  const v = new DataView(out.buffer);
  v.setUint32(4, 1);
  v.setUint32(12, 4);
  v.setUint16(FIXED + 2, 496); // INTEGER
  v.setUint32(FIXED + 4, 4);
  v.setUint16(FIXED + 12, 65535);
  v.setUint32(FIXED + 32, REPEAT);
  v.setUint32(FIXED + 36, varLen);
  const varAt = FIXED + REPEAT;
  v.setUint32(varAt, varLen);
  v.setUint16(varAt + 4, 0x3840);
  v.setUint16(varAt + 6, 37);
  out.set(name, varAt + 8);
  return out;
}

function resultRows(from: number, n: number): Uint8Array {
  const rowSize = 4;
  const out = new Uint8Array(20 + n * (2 + rowSize));
  const v = new DataView(out.buffer);
  v.setUint32(4, n);
  v.setUint16(8, 1);
  v.setUint16(10, 2);
  v.setUint32(16, rowSize);
  const dataAt = 20 + n * 2;
  for (let i = 0; i < n; i++) v.setInt32(dataAt + i * rowSize, from + i);
  return out;
}

interface Frame {
  reqId: number;
  params?: readonly { cp: number; value: Uint8Array }[];
}

/** `total` 行の結果セットを演じる偽の接続。要求されたブロック数を超えて返さない */
function fakeConn(total: number) {
  const fetches: number[] = [];
  let served = 0;
  const conn = {
    host: HOST,
    port: 8471,
    jobName: "123456/QUSER/QZDASOINIT",
    isClosed: false,
    acquire: () => () => undefined,
    close: () => undefined,
    request: async (frame: Frame) => {
      const ok = { rcClass: 0, rcClassReturnCode: 0 };
      if (frame.reqId === REQ.prepareAndDescribe) {
        return {
          params: [
            { cp: CP_SUPER_EXT_FORMAT, value: format1Int() },
            { cp: CP_SQLCA, value: sqlca() }
          ],
          dbTemplate: ok
        };
      }
      if (frame.reqId === REQ.fetch) {
        const bf = frame.params?.find((p) => p.cp === CP_BLOCKING_FACTOR);
        const block = bf ? new DataView(bf.value.buffer, bf.value.byteOffset).getUint32(0) : 0;
        fetches.push(block);
        const n = Math.max(0, Math.min(block, total - served));
        const from = served + 1;
        served += n;
        return {
          params: [
            { cp: CP_EXT_RESULT, value: resultRows(from, n) },
            { cp: CP_SQLCA, value: sqlca(n === 0 ? 100 : 0) }
          ],
          dbTemplate: ok
        };
      }
      return { params: [{ cp: CP_SQLCA, value: sqlca() }], dbTemplate: ok };
    }
  } as unknown as DbConnection;
  return { conn, fetches, served: () => served };
}

/** 偽の接続を使うアプリ。単発経路（`openDb`）とプール経路の両方に同じものを渡す */
function appWith(fake: ReturnType<typeof fakeConn>) {
  openDbMock.mockResolvedValue(fake.conn);
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
    post: (body: Record<string, unknown>) =>
      app.request("/api/host/sql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: { system: "srv:s" }, ...body })
      })
  };
}

beforeAll(() => {
  process.env[PW_ENV] = DUMMY_PW;
});
afterAll(() => {
  delete process.env[PW_ENV];
});

describe("単発経路（pageSize 無し）の取得量", () => {
  it("**上限ぶんしかホストから取らない**（1000 行の表を上限 10 で読む）", async () => {
    const fake = fakeConn(1000);
    const res = await appWith(fake).post({ sql: "SELECT ID FROM T", maxRows: 10 });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rowCount).toBe(10);
    expect(body.truncated).toBe(true);
    // **これが要点**: 取ってきたのは 11 行（上限＋続き確認の 1 行）
    expect(fake.served()).toBe(11);
    expect(fake.fetches).toEqual([11]);
  });

  it("既定（200 行）でも全件は取らない", async () => {
    const fake = fakeConn(1000);
    const body = await (await appWith(fake).post({ sql: "SELECT ID FROM T" })).json();
    expect(body.rowCount).toBe(200);
    expect(body.truncated).toBe(true);
    expect(fake.served()).toBe(201);
  });

  it("上限ちょうどの結果セットで truncated が嘘にならない", async () => {
    const fake = fakeConn(10);
    const body = await (await appWith(fake).post({ sql: "SELECT ID FROM T", maxRows: 10 })).json();
    expect(body.rowCount).toBe(10);
    expect(body.truncated).toBe(false);
  });

  it("上限より少なければそのまま返す", async () => {
    const fake = fakeConn(3);
    const body = await (await appWith(fake).post({ sql: "SELECT ID FROM T", maxRows: 10 })).json();
    expect(body.rowCount).toBe(3);
    expect(body.truncated).toBe(false);
    expect(body.columns[0].name).toBe("ID");
  });
});

/**
 * **MCP の `host_sql` も同じ上限で取る。** ここを見ていないと、
 * MCP だけ全件取得に戻っても単体テストが気づかない（空振り検証で実際に空振りした）。
 */
describe("MCP host_sql の取得量", () => {
  /** 実際の登録コードを通してハンドラを捕まえる */
  function hostSqlOf(fake: ReturnType<typeof fakeConn>) {
    openDbMock.mockResolvedValue(fake.conn);
    const server = new ServerConfigStore({
      systems: [{ id: "s", name: "s", host: HOST, signon: { user: USER, passwordEnv: PW_ENV } }],
      sessions: []
    });
    const handlers = new Map<string, (input: Record<string, unknown>) => Promise<{ content: { text: string }[] }>>();
    registerHostServerTools(
      {
        registerTool: (name: string, _meta: unknown, handler: never) => handlers.set(name, handler),
        registerResource: () => undefined,
        registerPrompt: () => undefined
      } as never,
      {
        sessions: new SessionManager(),
        resolver: new ConfigResolver(server, new PersonalConfigStore({ systems: [], sessions: [] })),
        version: "test"
      }
    );
    const handler = handlers.get("host_sql");
    if (!handler) throw new Error("host_sql が登録されていない");
    return async (input: Record<string, unknown>) =>
      JSON.parse((await handler({ system: "srv:s", ...input })).content[0]!.text) as {
        rowCount: number;
        truncated: boolean;
      };
  }

  it("**上限ぶんしかホストから取らない**（既定 200）", async () => {
    const fake = fakeConn(1000);
    const body = await hostSqlOf(fake)({ sql: "SELECT ID FROM T" });
    expect(body.rowCount).toBe(200);
    expect(body.truncated).toBe(true);
    expect(fake.served()).toBe(201);
  });

  it("maxRows を渡すとそこで打ち切る", async () => {
    const fake = fakeConn(1000);
    const body = await hostSqlOf(fake)({ sql: "SELECT ID FROM T", maxRows: 5 });
    expect(body.rowCount).toBe(5);
    expect(fake.served()).toBe(6);
    expect(fake.fetches).toEqual([6]);
  });

  it("上限ちょうどでは truncated が false", async () => {
    const fake = fakeConn(5);
    const body = await hostSqlOf(fake)({ sql: "SELECT ID FROM T", maxRows: 5 });
    expect(body.rowCount).toBe(5);
    expect(body.truncated).toBe(false);
  });
});

describe("上限の入力検証（サーバー側で強制する）", () => {
  it("上限 1000 を超える指定を拒否する", async () => {
    const res = await appWith(fakeConn(10)).post({ sql: "SELECT ID FROM T", maxRows: 1001 });
    expect(res.status).toBe(400);
  });

  it("0 以下・小数を拒否する（黙って全件にしない）", async () => {
    for (const maxRows of [0, -1, 1.5]) {
      const res = await appWith(fakeConn(10)).post({ sql: "SELECT ID FROM T", maxRows });
      expect(res.status).toBe(400);
    }
  });
});

/**
 * **ページングを使う経路は結果セットを保持する**（上限つき取得には載せ替えない）。
 * 混ぜると「続きを読む」規律が壊れるので、経路が分かれていることを固定する。
 */
describe("ページング経路は変えていない", () => {
  it("pageSize を指定すると結果セット ID を返し、要求は pageSize ぶん", async () => {
    const fake = fakeConn(1000);
    const res = await appWith(fake).post({ sql: "SELECT ID FROM T", pageSize: 50 });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rowCount).toBe(50);
    expect(body.hasMore).toBe(true);
    expect(body.resultSetId).toBeTruthy();
    // ページングは**既定ブロックで刻む**（上限つき取得の「残りに合わせる」ではない）
    expect(fake.fetches[0]).toBe(100);
  });

  it("非クエリ文はこの経路に来ない（kind: execute のまま）", async () => {
    const fake = fakeConn(0);
    const res = await appWith(fake).post({ sql: "DELETE FROM T WHERE ID = 0", pageSize: 50 });
    const body = await res.json();
    expect(body.kind).toBe("execute");
  });

  /**
   * **「1 ページだけ見て閉じる」使い方でも接続を掴まない。**
   *
   * backlog `hostserver.md` は「ページング経路も上限つき取得に寄せるか」を保留にしていた
   * ——掴んだままだと次の実行が接続を使い回せず、小さな表でも毎回 6 秒かかるため。
   * ⚠ **だが寄せる必要は無い**: 読み切った（`hasMore: false`）ページは、その場で
   * 結果セットを閉じて接続をプールへ返している。
   *
   * 寄せてしまうと**「続きを読む」が成立しなくなる**（結果セットを保持しないので）。
   * 掴む問題だけがここで解けているなら、経路は分けたままでよい。
   */
  it("**1 ページで読み切ったら結果セット ID を返さない**（続きを取りに行かせない）", async () => {
    const fake = fakeConn(10);
    const res = await appWith(fake).post({ sql: "SELECT ID FROM T", pageSize: 50 });
    const body = await res.json();
    expect(body.rowCount).toBe(10);
    expect(body.hasMore).toBe(false);
    expect(body.resultSetId, "掴み続けないので id を渡さない").toBeUndefined();
  });
});
