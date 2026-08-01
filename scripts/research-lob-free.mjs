// LOB ロケーターの解放（CP 要求 0x1819）を実機で確かめる。
//
// 要求形式は原典から確定済み（`20260801-lob-batch-retrieval-research`）だが、
// **解放が実際に効くのか / 接続を閉じれば消えるのか**は測っていない。
// 単発接続（呼び出しごとに開いて閉じる）のこのプロジェクトでは、
// 後者が真なら明示的な解放は要らない——それを判断するための実測。
//
// 実行: AS400_HOST=... AS400_USER=... AS400_PASSWORD=... node --env-file=.env \
//         scripts/research-lob-free.mjs
//
// 表は `research-lob-threshold.mjs` が作る TESTLIB.LOBTHR を使う（無ければ作る）。
import { DbConnection, executeStatement, openQuery, retrieveLob, freeLob } from "@as400web/hostserver";
import { setLogSink } from "@as400web/base";

// **解放の戻りコードはログにしか出ない**（`freeLob` は投げない）。ここでは見たいので拾う
setLogSink(() => ({
  debug: (m) => /LOB/.test(m) && process.stdout.write(`      [debug] ${m}\n`),
  info: () => {},
  warn: (m) => process.stdout.write(`      [warn] ${m}\n`),
  error: (m) => process.stdout.write(`      [error] ${m}\n`),
  isDebugEnabled: () => true
}));

const host = process.env.AS400_HOST;
const user = process.env.AS400_USER;
const password = process.env.AS400_PASSWORD;
if (!host || !user || !password) {
  process.stderr.write("AS400_HOST / AS400_USER / AS400_PASSWORD を環境変数で渡してください\n");
  process.exit(2);
}

const LIB = process.env.AS400_LIB ?? "TESTLIB";
const TABLE = `${LIB}.LOBFREE`;
const log = (s) => process.stdout.write(s + "\n");

const connect = () => DbConnection.connect({ host, user, password });

/** 1 行目の LOB ロケーターを取る。カーソルは閉じるが接続は開いたまま */
async function firstLocator(conn) {
  const q = await openQuery(conn, `SELECT C FROM ${TABLE} ORDER BY ID`);
  // **break で抜けると generator の finally が走り、占有が解ける**
  for await (const row of q.rows) return row.C.locator;
  throw new Error("行が無い");
}

/** retrieveLob の結果を短く表す */
async function tryRetrieve(conn, locator, label) {
  try {
    const got = await retrieveLob(conn, locator, { maxBytes: 4096 });
    log(`  ${label}: 取得できた（${got.bytes.length} バイト / ccsid=${got.ccsid}）`);
    return "ok";
  } catch (e) {
    log(`  ${label}: ${e?.code ?? ""} ${String(e?.message ?? e).split("\n")[0]}`);
    return "error";
  }
}

// --- 準備 ---------------------------------------------------------------
{
  const conn = await connect();
  try {
    try { await executeStatement(conn, `DROP TABLE ${TABLE}`); } catch { /* 無ければ良い */ }
    await executeStatement(conn, `CREATE TABLE ${TABLE} (ID INT NOT NULL, C CLOB(1K))`);
    await executeStatement(conn, `INSERT INTO ${TABLE} VALUES (1, REPEAT('x', 200))`);
    log(`フィクスチャ: ${TABLE}（1 行）`);
  } finally {
    conn.close();
  }
}

// --- 1. 解放が効くか -----------------------------------------------------
log("\n### 1. 解放してから同じロケーターを引く");
{
  const conn = await connect();
  try {
    const loc = await firstLocator(conn);
    log(`  ロケーター=${loc}`);
    await tryRetrieve(conn, loc, "解放前");
    const freed = await freeLob(conn, loc);
    log(`  freeLob → ${freed}`);
    await tryRetrieve(conn, loc, "解放後");
  } finally {
    conn.close();
  }
}

// --- 2. 二重解放 ---------------------------------------------------------
log("\n### 2. 同じロケーターを 2 回解放する");
{
  const conn = await connect();
  try {
    const loc = await firstLocator(conn);
    log(`  1 回目 → ${await freeLob(conn, loc)}`);
    log(`  2 回目 → ${await freeLob(conn, loc)}`);
  } finally {
    conn.close();
  }
}

// --- 3. 接続を閉じたら消えるか -------------------------------------------
log("\n### 3. 接続を閉じてから、別の接続で同じ番号を引く");
{
  const first = await connect();
  let loc;
  try {
    loc = await firstLocator(first);
    log(`  ロケーター=${loc}（1 つ目の接続で採取）`);
  } finally {
    first.close();
  }
  const second = await connect();
  try {
    await tryRetrieve(second, loc, "別接続");
  } finally {
    second.close();
  }
}

// --- 4. 解放しないまま接続を閉じる（後始末が要るかの判断材料） -----------
log("\n### 4. 解放せずに接続を閉じる（ホストに残るか）");
{
  const conn = await connect();
  let loc;
  try {
    loc = await firstLocator(conn);
  } finally {
    conn.close(); // **解放しない**
  }
  log(`  解放せずに閉じた（ロケーター=${loc}）`);
  const again = await connect();
  try {
    const l2 = await firstLocator(again);
    log(`  新しい接続で採り直すと ${l2}（同じ番号が再び配られるなら使い回されている）`);
  } finally {
    again.close();
  }
}

log("\n完了");
