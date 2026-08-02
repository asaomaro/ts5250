import { describe, it, expect } from "vitest";
import { queryLimited, query, openQuery } from "../src/db/query.js";
import { As400Error } from "@ts5250/base";
import { codecForCcsid } from "@ts5250/ebcdic";
import type { DbConnection } from "../src/db/db-connection.js";

/**
 * 上限つき取得（早期打ち切り）。
 *
 * **要点は「ホストから取ってくる量が減っているか」**で、返す行数が合っていることだけでは
 * 足りない（今までも応答側で切ってはいた）。ここでは偽の接続で
 * **fetch の往復回数とブロッキング係数**を数え、取得量が減ったことを固定する。
 *
 * 実機の裏付け（実機・`20260730-sql-fetch-limit` research）:
 * 20,000 行の表で全件 201 往復 / 1,191,336 バイト / 2,072ms に対し、
 * 上限 200 なら 2 往復 / 11,912 バイト / 44ms。打ち切り後も接続は健全。
 */

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

/**
 * 超拡張列定義（`INTEGER` 1 列）。固定部 16 ＋ 繰り返し 48。
 * 列名は可変長部（CP 0x3840）に置く——省くと名前が空になる。
 */
function format1Int(name = "ID"): Uint8Array {
  const FIXED = 16;
  const REPEAT = 48;
  const nameBytes = [...name].map((c) => 0xc0 + (c.charCodeAt(0) - 0x40)); // 使わない（下で 37 を作る）
  void nameBytes;
  // EBCDIC(37) の "ID" は 0xC9 0xC4
  const ebcdic = new Uint8Array([0xc9, 0xc4]);
  const varLen = 8 + ebcdic.length;
  const out = new Uint8Array(FIXED + REPEAT + varLen);
  const v = new DataView(out.buffer);
  v.setUint32(4, 1); // 列数
  v.setUint32(12, 4); // レコード長
  const base = FIXED;
  v.setUint16(base + 2, 496); // INTEGER
  v.setUint32(base + 4, 4); // 長さ
  v.setUint16(base + 12, 65535); // CCSID（数値なので使わない）
  v.setUint32(base + 32, REPEAT); // 可変長部への相対位置
  v.setUint32(base + 36, varLen); // 可変長部の長さ
  const varAt = base + REPEAT;
  v.setUint32(varAt, varLen);
  v.setUint16(varAt + 4, 0x3840); // 列名
  v.setUint16(varAt + 6, 37); // 名前の CCSID
  out.set(ebcdic, varAt + 8);
  return out;
}

/**
 * 超拡張列定義（CLOB ロケーター 1 列）。`lobLocator` が 0 以外なら LOB として扱われる。
 * ロケーター列の中身は**ハンドル（4 バイト）**が並ぶ。
 */
function format1Clob(): Uint8Array {
  const FIXED = 16;
  const REPEAT = 48;
  const name = new Uint8Array([0xc3, 0xd3]); // EBCDIC(37) の "CL"
  const varLen = 8 + name.length;
  const out = new Uint8Array(FIXED + REPEAT + varLen);
  const v = new DataView(out.buffer);
  v.setUint32(4, 1);
  v.setUint32(12, 4);
  // **CLOB ロケーター（964）**。判定は型コードで行われる（`db-decode.ts` の説明）
  v.setUint16(FIXED + 2, 964);
  v.setUint32(FIXED + 4, 4); // ロケーターの幅
  v.setUint16(FIXED + 12, 37);
  v.setUint32(FIXED + 17, 1); // **lobLocator ≠ 0 = LOB 列**
  v.setUint32(FIXED + 26, 1024); // 最大長
  v.setUint32(FIXED + 32, REPEAT);
  v.setUint32(FIXED + 36, varLen);
  const varAt = FIXED + REPEAT;
  v.setUint32(varAt, varLen);
  v.setUint16(varAt + 4, 0x3840);
  v.setUint16(varAt + 6, 37);
  out.set(name, varAt + 8);
  return out;
}

/** 拡張結果データ。`n` 行ぶんの INTEGER を並べる */
function resultRows(from: number, n: number): Uint8Array {
  const rowSize = 4;
  const out = new Uint8Array(20 + n * (2 + rowSize));
  const v = new DataView(out.buffer);
  v.setUint32(4, n);
  v.setUint16(8, 1); // 列数
  v.setUint16(10, 2); // 指標サイズ
  v.setUint32(16, rowSize);
  const dataAt = 20 + n * 2;
  for (let i = 0; i < n; i++) v.setInt32(dataAt + i * rowSize, from + i);
  return out;
}

interface Frame {
  reqId: number;
  params?: readonly { cp: number; value: Uint8Array }[];
}

/**
 * `total` 行を持つ結果セットを演じる偽の接続。
 * **要求されたブロッキング係数を守る**（実機と同じで、要求より多くは返さない）。
 */
function fakeConn(total: number) {
  const fetches: number[] = []; // 各 fetch で要求されたブロック数
  let served = 0;
  let closed = 0;
  let busy = false;
  const conn = {
    acquire: () => {
      if (busy) throw new As400Error("PROTOCOL_ERROR", "another query is in progress");
      busy = true;
      return () => {
        busy = false;
      };
    },
    request: async (frame: Frame) => {
      switch (frame.reqId) {
        case REQ.prepareAndDescribe:
          return {
            params: [
              { cp: CP_SUPER_EXT_FORMAT, value: format1Int() },
              { cp: CP_SQLCA, value: sqlca() }
            ],
            dbTemplate: { rcClass: 0, rcClassReturnCode: 0 }
          };
        case REQ.openAndDescribe:
          return { params: [{ cp: CP_SQLCA, value: sqlca() }], dbTemplate: { rcClass: 0, rcClassReturnCode: 0 } };
        case REQ.fetch: {
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
            dbTemplate: { rcClass: 0, rcClassReturnCode: 0 }
          };
        }
        case REQ.closeCursor:
          closed += 1;
          return { params: [], dbTemplate: { rcClass: 0, rcClassReturnCode: 0 } };
        default:
          return { params: [], dbTemplate: { rcClass: 0, rcClassReturnCode: 0 } };
      }
    }
  } as unknown as DbConnection;
  return { conn, fetches, closed: () => closed, isBusy: () => busy, served: () => served };
}

describe("取得量が実際に減る", () => {
  it("上限 200 で 1000 行の表を読むと、ホストからは 201 行しか取らない", async () => {
    const f = fakeConn(1000);
    const res = await queryLimited(f.conn, "SELECT ID FROM T", { limit: 200 });

    expect(res.rows).toHaveLength(200);
    expect(res.truncated).toBe(true);
    // **これが要点**: 全件（1000 行）ではなく **201 行ぶん**で止まっている
    expect(f.served()).toBe(201);
    // 要求は 100・100・**1**。最後の 1 行は「続きがあるか」を見るためで、
    // ここでブロック 100 を要求すると 99 行ぶん無駄に届く
    expect(f.fetches).toEqual([100, 100, 1]);
  });

  it("同じ問い合わせを query（全件）で読むと 1000 行取ってしまう（対照）", async () => {
    const f = fakeConn(1000);
    const res = await query(f.conn, "SELECT ID FROM T");
    expect(res.rows).toHaveLength(1000);
    expect(f.served()).toBe(1000);
    // 全件取得の要求の形は変えていない（既定ブロックで刻むだけ）
    expect(new Set(f.fetches)).toEqual(new Set([100]));
  });

  it("上限が小さいときはブロッキング係数も絞る（既定 100 のままだと 100 行届く）", async () => {
    const f = fakeConn(1000);
    await queryLimited(f.conn, "SELECT ID FROM T", { limit: 1 });
    // 上限 1 → 要求は 2 行だけ。実機で 2,956 → 184 バイトに減った（research F3）
    expect(f.fetches).toEqual([2]);
    expect(f.served()).toBe(2);
  });

  it("上限が既定より大きいときはブロックを既定のまま刻む（1 往復を膨らませない）", async () => {
    const f = fakeConn(1000);
    await queryLimited(f.conn, "SELECT ID FROM T", { limit: 500 });
    // 100 行ずつ 5 回 ＋ 続き確認の 1 行。**上限ぶんを 1 往復に載せない**
    expect(f.fetches).toEqual([100, 100, 100, 100, 100, 1]);
    expect(f.served()).toBe(501);
  });

  it("上限に届かない結果セットでは余分に要求しない", async () => {
    const f = fakeConn(30);
    const res = await queryLimited(f.conn, "SELECT ID FROM T", { limit: 100 });
    expect(res.rows).toHaveLength(30);
    // 1 回で尽きたと分かる（要求 100 に対して 30 行しか返らなかった）
    expect(f.fetches).toEqual([100]);
  });
});

describe("続きの有無を測った事実として返す", () => {
  it("上限より多い結果セットは truncated: true", async () => {
    const f = fakeConn(1000);
    const res = await queryLimited(f.conn, "SELECT ID FROM T", { limit: 10 });
    expect(res.rows).toHaveLength(10);
    expect(res.truncated).toBe(true);
  });

  it("**上限ちょうど**は truncated: false（ここで嘘をつかない）", async () => {
    const f = fakeConn(10);
    const res = await queryLimited(f.conn, "SELECT ID FROM T", { limit: 10 });
    expect(res.rows).toHaveLength(10);
    expect(res.truncated).toBe(false);
  });

  it("上限＋1 ちょうどは truncated: true", async () => {
    const f = fakeConn(11);
    const res = await queryLimited(f.conn, "SELECT ID FROM T", { limit: 10 });
    expect(res.rows).toHaveLength(10);
    expect(res.truncated).toBe(true);
  });

  it("上限より少なければそのまま返す", async () => {
    const f = fakeConn(3);
    const res = await queryLimited(f.conn, "SELECT ID FROM T", { limit: 10 });
    expect(res.rows.map((r) => r.ID)).toEqual([1, 2, 3]);
    expect(res.truncated).toBe(false);
  });

  it("0 行でも壊れない", async () => {
    const f = fakeConn(0);
    const res = await queryLimited(f.conn, "SELECT ID FROM T", { limit: 10 });
    expect(res.rows).toEqual([]);
    expect(res.truncated).toBe(false);
    expect(res.columns).toHaveLength(1);
  });

  it("上限を 1 行も超えて返さない", async () => {
    for (const [total, limit] of [
      [1000, 1],
      [1000, 99],
      [1000, 100],
      [1000, 101]
    ] as const) {
      const f = fakeConn(total);
      const res = await queryLimited(f.conn, "SELECT ID FROM T", { limit });
      expect(res.rows).toHaveLength(limit);
    }
  });
});

/**
 * **LOB を落とさない。** `query()` は LOB のロケーターを同じ接続の中で本体に差し替える。
 * 上限つき取得で同じことをしないと、**LOB 列だけ中身が空**の結果が返る
 * （ロケーターは接続に紐づくので、呼び出し側は後から取り直せない）。
 */
describe("LOB", () => {
  const CP_LOB_DATA = 0x380f;
  const CP_LOB_LENGTH = 0x3810;
  const REQ_RETRIEVE_LOB = 0x1816;

  /** CLOB 1 列・1 行を返し、LOB 本体の要求にも答える偽の接続 */
  function lobConn(text: string) {
    let served = false;
    let lobRequests = 0;
    const conn = {
      acquire: () => () => undefined,
      request: async (frame: Frame) => {
        const ok = { rcClass: 0, rcClassReturnCode: 0 };
        if (frame.reqId === REQ.prepareAndDescribe) {
          return {
            params: [
              { cp: CP_SUPER_EXT_FORMAT, value: format1Clob() },
              { cp: CP_SQLCA, value: sqlca() }
            ],
            dbTemplate: ok
          };
        }
        if (frame.reqId === REQ.fetch) {
          if (served) return { params: [{ cp: CP_EXT_RESULT, value: resultRows(0, 0) }], dbTemplate: ok };
          served = true;
          // ロケーターのハンドル 1 を 1 行ぶん
          const body = new Uint8Array(20 + 2 + 4);
          const v = new DataView(body.buffer);
          v.setUint32(4, 1); // 行数
          v.setUint16(8, 1); // 列数
          v.setUint16(10, 2); // 指標サイズ
          v.setUint32(16, 4); // 行サイズ
          v.setUint32(22, 1); // ロケーター = 1
          return {
            params: [
              { cp: CP_EXT_RESULT, value: body },
              { cp: CP_SQLCA, value: sqlca() }
            ],
            dbTemplate: ok
          };
        }
        if (frame.reqId === REQ_RETRIEVE_LOB) {
          lobRequests += 1;
          // **ホストは EBCDIC で返す**（CCSID 37）。UTF-8 で作ると復号できず生バイトになる
          const bytes = codecForCcsid(37).encode(text).bytes;
          // 長さ（幅 4）
          const len = new Uint8Array(6);
          const lv = new DataView(len.buffer);
          lv.setUint16(0, 4);
          lv.setUint32(2, bytes.length);
          // 本体（CCSID(2) ＋ 長さ(4) ＋ データ）。1208 = UTF-8
          const data = new Uint8Array(6 + bytes.length);
          const dv = new DataView(data.buffer);
          dv.setUint16(0, 37);
          dv.setUint32(2, bytes.length);
          data.set(bytes, 6);
          return {
            params: [
              { cp: CP_LOB_LENGTH, value: len },
              { cp: CP_LOB_DATA, value: data }
            ],
            dbTemplate: ok
          };
        }
        return { params: [{ cp: CP_SQLCA, value: sqlca() }], dbTemplate: ok };
      }
    } as unknown as DbConnection;
    return { conn, lobRequests: () => lobRequests };
  }

  it("lob を指定するとロケーターを本体に差し替える", async () => {
    const f = lobConn("LOB BODY");
    const res = await queryLimited(f.conn, "SELECT CL FROM T", { limit: 10, lob: { maxBytes: 1024 } });
    expect(f.lobRequests()).toBe(1);
    expect((res.rows[0]!.CL as { value?: string }).value).toBe("LOB BODY");
  });

  it("lob を指定しなければ取りに行かない（既定では取得しない）", async () => {
    const f = lobConn("x");
    const res = await queryLimited(f.conn, "SELECT CL FROM T", { limit: 10 });
    expect(f.lobRequests()).toBe(0);
    expect((res.rows[0]!.CL as { kind: string }).kind).toBe("lob");
  });
});

describe("後始末と入力の検証", () => {
  it("カーソルを閉じ、占有を解く（次の問い合わせが通る）", async () => {
    const f = fakeConn(1000);
    await queryLimited(f.conn, "SELECT ID FROM T", { limit: 10 });
    expect(f.closed()).toBe(1);
    expect(f.isBusy()).toBe(false);
    // 続けてもう 1 度読める（実機でも 10 回連続で確認済み。research F1）
    await expect(queryLimited(f.conn, "SELECT ID FROM T", { limit: 10 })).resolves.toBeDefined();
  });

  it("**打ち切ったときも**カーソルを閉じる（閉じ忘れると接続が使えなくなる）", async () => {
    const f = fakeConn(1000);
    const res = await queryLimited(f.conn, "SELECT ID FROM T", { limit: 10 });
    expect(res.truncated).toBe(true); // 打ち切っている
    expect(f.closed()).toBe(1);
  });

  it("読み切ったときもカーソルを閉じる", async () => {
    const f = fakeConn(3);
    const res = await queryLimited(f.conn, "SELECT ID FROM T", { limit: 10 });
    expect(res.truncated).toBe(false);
    expect(f.closed()).toBe(1);
  });

  it("上限 0 以下・整数でない値は断る（黙って全件にしない）", async () => {
    const f = fakeConn(1000);
    for (const limit of [0, -1, 1.5, Number.NaN]) {
      const err = await queryLimited(f.conn, "SELECT ID FROM T", { limit }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(As400Error);
      expect((err as As400Error).code).toBe("CONFIG_ERROR");
    }
    // **1 度も問い合わせていない**（断るのは要求を出す前）
    expect(f.fetches).toHaveLength(0);
  });
});

/**
 * **`openQuery` が失敗したときの占有**。
 *
 * prepare が失敗したときに占有を解いていなかったため、SQL の誤り 1 回で
 * その接続が二度と使えなくなっていた（以降すべて「another query is in progress」）。
 * 単発接続では接続ごと閉じるので隠れていたが、実機で確かめて直した（decisions D1）。
 */
describe("開けなかったときも占有を解く", () => {
  function failingConn() {
    let busy = false;
    const conn = {
      acquire: () => {
        if (busy) throw new As400Error("PROTOCOL_ERROR", "another query is in progress");
        busy = true;
        return () => {
          busy = false;
        };
      },
      request: async () => {
        throw new As400Error("SQL_ERROR", "prepare failed: SQLCODE=-204");
      }
    } as unknown as DbConnection;
    return { conn, isBusy: () => busy };
  }

  it("openQuery が prepare で失敗しても占有が残らない", async () => {
    const f = failingConn();
    await expect(openQuery(f.conn, "SELECT * FROM NOSUCH")).rejects.toThrow(/prepare failed/);
    expect(f.isBusy()).toBe(false);
  });

  it("queryLimited が失敗しても占有が残らない", async () => {
    const f = failingConn();
    await expect(queryLimited(f.conn, "SELECT * FROM NOSUCH", { limit: 10 })).rejects.toThrow(
      /prepare failed/
    );
    expect(f.isBusy()).toBe(false);
  });
});
