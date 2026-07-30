// 実機で**結果セットの早期打ち切り**を実測する。
//
// 問い（`.aidev/backlog/hostserver.md`）:
//   `maxRows` は「応答に載せる行数の上限」であって「ホストから取る行数の上限」ではない。
//   抑えるには途中でカーソルを閉じる（`openQuery` の `return()`）必要があるが、
//   **「途中で閉じたあとホストが健全か」が未検証**で採用できていない。
//
// ここで確かめること:
//   1. 途中で `return()` した後、**同じ接続でそのまま次の SQL が通るか**
//   2. **ホストからの取得が実際に減るか**（fetch 往復の回数を数える）
//   3. ブロック境界のちょうど・前・後で打ち切っても同じか
//   4. 打ち切りを**繰り返しても**接続が壊れないか
//   5. 全件取得と打ち切りで**所要時間・受信バイト数に差が出るか**
//   6. 打ち切った直後に**同じ接続で更新系（非クエリ）**も通るか
//   7. **ブロッキング係数を上限に合わせると受信量がさらに減るか**
//      （既定 100 のままだと上限 1 でも 100 行ぶん届く）
//
// 実行: AS400_PASSWORD=... node scripts/research-sql-cancel.mjs
import { readFileSync } from "node:fs";
import { DbConnection, openQuery, query, executeStatement } from "@as400web/core";

const out = (s) => process.stdout.write(s + "\n");
// **QTEMP を使う**（必ず存在し、接続ごとに消えるので後片付けが要らない）
const LIB = "QTEMP";
const T = "CANCELT";
/** 行数。ブロッキング係数（既定 100）を何度も跨ぐ規模にする */
const ROWS = 1000;

const conns = JSON.parse(readFileSync("connections.json", "utf8"));
const sys = conns.systems.find((s) => s.name === "実機");
const password = process.env.AS400_PASSWORD;
if (!password) {
  out("AS400_PASSWORD が未設定です");
  process.exit(1);
}

const connect = () =>
  DbConnection.connect({
    host: sys.host,
    user: sys.signon.user,
    password,
    ...(sys.tls !== undefined ? { tls: sys.tls } : {})
  });

/**
 * `conn.request` を包んで **fetch の往復回数と受信バイト数**を数える。
 * 「取得量が本当に減ったか」は往復回数だけでは分からない
 * （1 往復でブロッキング係数ぶん届くため）。応答パラメータの長さを足して量を見る。
 */
function countFetches(conn) {
  const FETCH = 0x180b; // DB_REQ.fetch
  const original = conn.request.bind(conn);
  const counter = { fetch: 0, all: 0, bytes: 0 };
  conn.request = async (frame) => {
    counter.all += 1;
    const isFetch = frame.reqId === FETCH;
    if (isFetch) counter.fetch += 1;
    const reply = await original(frame);
    if (isFetch) for (const p of reply.params ?? []) counter.bytes += p.value?.length ?? 0;
    return reply;
  };
  return { counter, restore: () => (conn.request = original) };
}

/** 上限 n 行だけ読んでジェネレータを閉じる。**閉じるのは finally で必ず** */
async function readAtMost(conn, sql, n, blockSize) {
  const { columns, rows } = await openQuery(conn, sql, blockSize ? { blockSize } : {});
  const got = [];
  try {
    for await (const row of rows) {
      got.push(row);
      if (got.length >= n) break; // for-await の break は return() を呼ぶ
    }
  } finally {
    await rows.return(undefined);
  }
  return { columns, got };
}

let conn;
try {
  conn = await connect();
  out(`接続 OK（${sys.host}）\n`);

  // --- 準備: 1000 行の表を作る ---
  await executeStatement(conn, `DROP TABLE ${LIB}.${T}`).catch(() => undefined);
  await executeStatement(conn, `CREATE TABLE ${LIB}.${T} (ID INT, S CHAR(20))`);
  // **1 文で埋める**（1000 回 INSERT すると 1000 往復になる）。
  // 再帰共通表式は実機でそのまま通った
  await executeStatement(
    conn,
    `INSERT INTO ${LIB}.${T} ` +
      `WITH N(I) AS (VALUES(1) UNION ALL SELECT I + 1 FROM N WHERE I < ${ROWS}) ` +
      `SELECT I, 'row' FROM N`
  );
  const total = await query(conn, `SELECT COUNT(*) AS N FROM ${LIB}.${T}`);
  out(`準備: ${LIB}.${T} に ${total.rows[0].N} 行\n`);

  const SQL = `SELECT ID, S FROM ${LIB}.${T} ORDER BY ID`;

  // --- 1) 全件取得の往復回数と所要時間（対照） ---
  {
    const { counter, restore } = countFetches(conn);
    const t0 = Date.now();
    const all = await query(conn, SQL);
    const ms = Date.now() - t0;
    restore();
    out(`---- 全件取得: ${all.rows.length} 行 / fetch ${counter.fetch} 往復 / ${counter.bytes} バイト / ${ms}ms`);
  }

  // --- 2) 早期打ち切り: 上限ごとの往復回数と所要時間 ---
  // **ブロック境界（100）のちょうど・前・後**を並べる
  for (const n of [1, 50, 99, 100, 101, 200, 250]) {
    const { counter, restore } = countFetches(conn);
    const t0 = Date.now();
    let got;
    let err;
    try {
      const r = await readAtMost(conn, SQL, n);
      got = r.got.length;
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    }
    const ms = Date.now() - t0;
    restore();
    out(
      `---- 上限 ${n}: 取得 ${got ?? "-"} 行 / fetch ${counter.fetch} 往復 / ` +
        `${counter.bytes} バイト / ${ms}ms${err ? ` / ERROR ${err}` : ""}`
    );

    // **同じ接続でそのまま次の SQL が通るか**（この検証の主目的）
    try {
      const after = await query(conn, `SELECT COUNT(*) AS N FROM ${LIB}.${T}`);
      out(`     → 打ち切り後の SELECT: OK（${after.rows[0].N} 行）`);
    } catch (e) {
      out(`     → 打ち切り後の SELECT: **失敗** ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // --- 3) 打ち切りを繰り返す（10 回）---
  let repeatOk = true;
  for (let i = 0; i < 10; i++) {
    try {
      await readAtMost(conn, SQL, 10);
    } catch (e) {
      repeatOk = false;
      out(`---- 繰り返し ${i + 1} 回目で失敗: ${e instanceof Error ? e.message : String(e)}`);
      break;
    }
  }
  out(`---- 打ち切りを 10 回繰り返す: ${repeatOk ? "OK" : "NG"}`);

  // --- 4) 打ち切った直後に**更新系**が通るか（文名が別なので踏み合わないはず） ---
  try {
    await readAtMost(conn, SQL, 5);
    const res = await executeStatement(conn, `UPDATE ${LIB}.${T} SET S = 'upd' WHERE ID = 1`);
    out(`---- 打ち切り直後の UPDATE: OK（${res.updateCount} 行）`);
  } catch (e) {
    out(`---- 打ち切り直後の UPDATE: **失敗** ${e instanceof Error ? e.message : String(e)}`);
  }

  // --- 5) 打ち切らずに放置したジェネレータ（比較用。**占有が解けないはず**）---
  {
    const { rows } = await openQuery(conn, SQL);
    const it = rows[Symbol.asyncIterator]();
    await it.next(); // 1 行だけ読んで放置
    try {
      await query(conn, `SELECT COUNT(*) AS N FROM ${LIB}.${T}`);
      out("---- 放置したまま次の SQL: **通ってしまった**（占有の歯止めが効いていない）");
    } catch (e) {
      out(`---- 放置したまま次の SQL: 断られた（期待どおり）— ${e instanceof Error ? e.message : String(e)}`);
    }
    await rows.return(undefined); // 後片付け
  }

  // --- 6) 「続きがあるか」を上限＋1 で判定できるか ---
  // 上限ちょうどの結果セット（1000 行を 1000 で切る）で嘘をつかないか
  for (const [label, n] of [
    ["続きあり（1000 行を 200 で切る）", 200],
    ["ちょうど（1000 行を 1000 で切る）", 1000],
    ["上限より少ない（1000 行を 1500 で切る）", 1500]
  ]) {
    const r = await readAtMost(conn, SQL, n + 1);
    out(`---- ${label}: n+1 まで読むと ${r.got.length} 行 → 続きは ${r.got.length > n ? "ある" : "ない"}`);
  }

  // --- 7) ブロッキング係数を上限に合わせると受信量が減るか ---
  out("");
  for (const [n, bs] of [
    [1, undefined],
    [1, 1],
    [10, undefined],
    [10, 10],
    [200, undefined],
    [200, 200]
  ]) {
    const { counter, restore } = countFetches(conn);
    const t0 = Date.now();
    const r = await readAtMost(conn, SQL, n, bs);
    const ms = Date.now() - t0;
    restore();
    out(
      `---- 上限 ${n} / ブロック ${bs ?? "既定(100)"}: 取得 ${r.got.length} 行 / ` +
        `fetch ${counter.fetch} 往復 / ${counter.bytes} バイト / ${ms}ms`
    );
  }

  // --- 8) 大きな表（20,000 行）で全件と打ち切りを比べる ---
  out("");
  const BIG = "CANCELB";
  const BIG_ROWS = 20000;
  await executeStatement(conn, `DROP TABLE ${LIB}.${BIG}`).catch(() => undefined);
  await executeStatement(conn, `CREATE TABLE ${LIB}.${BIG} (ID INT, S CHAR(50))`);
  await executeStatement(
    conn,
    `INSERT INTO ${LIB}.${BIG} ` +
      `WITH N(I) AS (VALUES(1) UNION ALL SELECT I + 1 FROM N WHERE I < ${BIG_ROWS}) ` +
      `SELECT I, 'padding padding padding padding' FROM N`
  );
  const BIG_SQL = `SELECT ID, S FROM ${LIB}.${BIG} ORDER BY ID`;
  {
    const { counter, restore } = countFetches(conn);
    const t0 = Date.now();
    const all = await query(conn, BIG_SQL);
    const ms = Date.now() - t0;
    restore();
    out(`---- 大: 全件取得 ${all.rows.length} 行 / fetch ${counter.fetch} 往復 / ${counter.bytes} バイト / ${ms}ms`);
  }
  {
    const { counter, restore } = countFetches(conn);
    const t0 = Date.now();
    const r = await readAtMost(conn, BIG_SQL, 200);
    const ms = Date.now() - t0;
    restore();
    out(`---- 大: 上限 200 / 既定ブロック: 取得 ${r.got.length} 行 / fetch ${counter.fetch} 往復 / ${counter.bytes} バイト / ${ms}ms`);
    const after = await query(conn, `SELECT COUNT(*) AS N FROM ${LIB}.${BIG}`);
    out(`     → 打ち切り後の SELECT: OK（${after.rows[0].N} 行）`);
  }
  await executeStatement(conn, `DROP TABLE ${LIB}.${BIG}`).catch(() => undefined);

  await executeStatement(conn, `DROP TABLE ${LIB}.${T}`).catch(() => undefined);
} catch (e) {
  out("ERROR: " + (e instanceof Error ? e.message : String(e)));
  out(e?.stack ?? "");
} finally {
  conn?.close?.();
}
