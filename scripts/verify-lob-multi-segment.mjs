// **64KB を超える LOB の分割受信**が直ったことを実機で確かめる
// （`20260802-lob-multi-segment`）。
//
// 直す前は、2 バイト CCSID（UTF-16 / 純 DBCS）で分割が 2 周目に入ると
// `lobStartOffset` にバイト数を入れていたせいで**位置が 2 倍に飛び、中身が抜けていた**
// ——しかも穴の空いた値に `too-large`（＝末尾で切れた、の意）が付くので気づけない。
//
// 事実の採取は `research-lob-multi-segment.mjs`。こちらは**直った後の値**を検査する。
//
// 実行: AS400_HOST=... AS400_USER=... AS400_PASSWORD=... node --env-file=.env \
//         scripts/verify-lob-multi-segment.mjs
//
// 副作用: 自分のライブラリーに表を 1 つ作り、**finally で必ず消す**。
import { DbConnection, executeStatement, query } from "@as400web/hostserver";

const host = process.env.AS400_HOST;
const user = process.env.AS400_USER;
const password = process.env.AS400_PASSWORD;
if (!host || !user || !password) {
  process.stderr.write("AS400_HOST / AS400_USER / AS400_PASSWORD を環境変数で渡してください\n");
  process.exit(2);
}

const LIB = process.env.AS400_LIB ?? "TESTLIB";
const TABLE = `${LIB}.LOBSEGV`;
const log = (s) => process.stdout.write(s + "\n");
let pass = 0;
let fail = 0;
const check = (cond, msg) => {
  if (cond) { pass++; log(`  PASS ${msg}`); } else { fail++; log(`  FAIL ${msg}`); }
};

/** 目標サイズ（バイト）。1 応答の上限（65,535 文字）を確実に跨がせる */
const TARGET_BYTES = 200_000;
const SEED_C = "ABCDEFGH";
const SEED_G = "あいうえおかきく";

/** 先頭から連続しているか——**中抜けはここでしか見つからない** */
function contiguous(value, seed) {
  if (typeof value !== "string") return false;
  for (let i = 0; i < value.length; i++) {
    if (value[i] !== seed[i % seed.length]) return { at: i };
  }
  return true;
}

const conn = await DbConnection.connect({ host, user, password });
try {
  try { await executeStatement(conn, `DROP TABLE ${TABLE}`); } catch { /* 無ければ良い */ }
  await executeStatement(
    conn,
    `CREATE TABLE ${TABLE} (ID INT NOT NULL, C CLOB(1M), G DBCLOB(1M) CCSID 1200)`
  );
  // 倍々に伸ばす（SQL 文の長さ制限に当たらない）
  await executeStatement(
    conn,
    `INSERT INTO ${TABLE} VALUES (1, CAST('${SEED_C}' AS CLOB(1M)), CAST('${SEED_G}' AS DBCLOB(1M) CCSID 1200))`
  );
  for (let i = 0; i < 15; i++) {
    await executeStatement(conn, `UPDATE ${TABLE} SET C = C || C, G = G || G WHERE ID = 1`);
    const m = await query(conn, `SELECT OCTET_LENGTH(C) AS CB, OCTET_LENGTH(G) AS GB FROM ${TABLE}`);
    if (Number(m.rows[0].CB) >= TARGET_BYTES && Number(m.rows[0].GB) >= TARGET_BYTES) break;
  }
  const sz = (
    await query(conn, `SELECT OCTET_LENGTH(C) AS CB, LENGTH(C) AS CC, OCTET_LENGTH(G) AS GB, LENGTH(G) AS GC FROM ${TABLE}`)
  ).rows[0];
  const cBytes = Number(sz.CB);
  const gBytes = Number(sz.GB);
  log(`フィクスチャ: ${TABLE}`);
  log(`  C (CLOB 混在)        : ${cBytes} バイト / ${sz.CC} 文字`);
  log(`  G (DBCLOB CCSID 1200): ${gBytes} バイト / ${sz.GC} 文字（バイト = 文字 × 2）\n`);

  // ---- 1. UTF-16 の分割受信（2 セグメント）----
  log(`### 1. DBCLOB(1200) を上限 ${TARGET_BYTES} バイトで取る（分割 2 周）`);
  {
    const cell = (await query(conn, `SELECT G FROM ${TABLE} WHERE ID = 1`, { lob: { maxBytes: TARGET_BYTES } }))
      .rows[0].G;
    const v = cell?.value;
    const chars = typeof v === "string" ? v.length : 0;
    log(`  取れた: ${chars} 文字 = ${chars * 2} バイト / unavailable=${cell?.unavailable ?? "(なし)"}`);
    const cont = contiguous(v, SEED_G);
    check(cont === true, `**先頭から連続している（中抜けが無い）**${cont === true ? "" : ` — ${cont.at} 文字目で食い違う`}`);
    check(chars * 2 <= TARGET_BYTES, `上限を超えて保持しない（${chars * 2} ≦ ${TARGET_BYTES}）`);
    check(chars * 2 === TARGET_BYTES, `上限ちょうどまで取れる（${chars * 2}）`);
    check(cell?.byteLength === gBytes, `全体長はバイトで申告（${cell?.byteLength} / 実際 ${gBytes}）`);
    check(cell?.unavailable === "too-large", "打ち切りの印が立つ");
  }

  // ---- 2. 1 セグメントに収まる打ち切り ----
  log(`\n### 2. DBCLOB(1200) を上限 40,000 バイトで取る（1 周・従来は 80,000 バイト来ていた）`);
  {
    const cell = (await query(conn, `SELECT G FROM ${TABLE} WHERE ID = 1`, { lob: { maxBytes: 40_000 } })).rows[0].G;
    const v = cell?.value;
    const chars = typeof v === "string" ? v.length : 0;
    log(`  取れた: ${chars} 文字 = ${chars * 2} バイト`);
    check(chars * 2 === 40_000, `上限ちょうど（${chars * 2}）——**2 倍に膨らまない**`);
    check(contiguous(v, SEED_G) === true, "先頭から連続している");
    check(cell?.unavailable === "too-large", "打ち切りの印が立つ");
  }

  // ---- 3. 混在 CLOB は変化なし（元から正しい経路を壊していない）----
  log(`\n### 3. CLOB(混在) を上限 ${TARGET_BYTES} バイトで取る（回帰）`);
  {
    const cell = (await query(conn, `SELECT C FROM ${TABLE} WHERE ID = 1`, { lob: { maxBytes: TARGET_BYTES } }))
      .rows[0].C;
    const v = cell?.value;
    const len = typeof v === "string" ? v.length : 0;
    log(`  取れた: ${len} 文字`);
    check(len === TARGET_BYTES, `上限ちょうど（${len}）`);
    check(contiguous(v, SEED_C) === true, "先頭から連続している");
    check(cell?.byteLength === cBytes, `全体長が一致（${cell?.byteLength}）`);
  }

  // ---- 4. 全部収まる場合（打ち切らない）----
  log("\n### 4. 小さい LOB は完全に取れる（truncated が立たない）");
  {
    await executeStatement(
      conn,
      `INSERT INTO ${TABLE} VALUES (2, CAST('${SEED_C}' AS CLOB(1M)), CAST('${SEED_G}' AS DBCLOB(1M) CCSID 1200))`
    );
    const row = (await query(conn, `SELECT C, G FROM ${TABLE} WHERE ID = 2`, { lob: { maxBytes: 64 * 1024 } }))
      .rows[0];
    check(row.C?.value === SEED_C, `CLOB が完全一致（${JSON.stringify(row.C?.value)}）`);
    check(row.G?.value === SEED_G, `DBCLOB が完全一致（${JSON.stringify(row.G?.value)}）`);
    check(row.C?.unavailable === undefined && row.G?.unavailable === undefined, "打ち切りの印が立たない");
  }
} catch (e) {
  fail++;
  log(`  FAIL 例外: ${e?.stack ?? e}`);
} finally {
  try { await executeStatement(conn, `DROP TABLE ${TABLE}`); } catch { /* 良い */ }
  conn.close?.();
}

log(`\n${fail === 0 ? "OK" : "NG"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
