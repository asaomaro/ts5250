// **純 DBCS（CCSID 300）と BLOB の 64KB 超**を実機で確かめる
// （`20260802-lob-big-dbcs-blob`）。
//
// `20260802-lob-multi-segment`（PR #289）は分割受信の単位を直したが、実機で測ったのは
// **UTF-16（1200）と混在 CLOB** だけで、この 2 系統は「同じ枝だから同じはず」という
// **判断で押していた**。LOB の単位はその同型の推論で 3 度踏んでいるので、実測で閉じる。
//
// 実行: AS400_HOST=... AS400_USER=... AS400_PASSWORD=... node --env-file=.env \
//         scripts/verify-lob-big-dbcs-blob.mjs
//
// 副作用: 自分のライブラリーに表を 1 つ作り、**finally で必ず消す**。
import { DbConnection, executeStatement, query } from "@ts5250/hostserver";

const host = process.env.AS400_HOST;
const user = process.env.AS400_USER;
const password = process.env.AS400_PASSWORD;
if (!host || !user || !password) {
  process.stderr.write("AS400_HOST / AS400_USER / AS400_PASSWORD を環境変数で渡してください\n");
  process.exit(2);
}

const LIB = process.env.AS400_LIB ?? "TESTLIB";
const TABLE = `${LIB}.LOBBIGV`;
/** 純 DBCS。**16684 はこの実機に変換表が無い**（`20260801-pure-dbcs-dbclob`） */
const DBCS_CCSID = process.env.AS400_DBCS_CCSID ?? "300";
const log = (s) => process.stdout.write(s + "\n");
const hex = (b, n = 16) => [...b.slice(0, n)].map((x) => x.toString(16).padStart(2, "0")).join(" ");
let pass = 0;
let fail = 0;
const check = (cond, msg) => {
  if (cond) { pass++; log(`  PASS ${msg}`); } else { fail++; log(`  FAIL ${msg}`); }
};

const TARGET_BYTES = 200_000;
const SEED_G = "あいうえおかきく";
const SEED_B_HEX = "0123456789ABCDEF";
const SEED_B = Uint8Array.from(SEED_B_HEX.match(/../g).map((h) => parseInt(h, 16)));

/** 先頭から連続しているか。**中抜けはここでしか見つからない** */
function contiguousStr(v, seed) {
  if (typeof v !== "string") return { at: -1, why: "文字列ではない" };
  for (let i = 0; i < v.length; i++) if (v[i] !== seed[i % seed.length]) return { at: i };
  return true;
}
function contiguousBytes(v, seed) {
  if (!(v instanceof Uint8Array)) return { at: -1, why: "バイト列ではない" };
  for (let i = 0; i < v.length; i++) if (v[i] !== seed[i % seed.length]) return { at: i };
  return true;
}

const conn = await DbConnection.connect({ host, user, password });
try {
  try { await executeStatement(conn, `DROP TABLE ${TABLE}`); } catch { /* 無ければ良い */ }
  await executeStatement(
    conn,
    `CREATE TABLE ${TABLE} (ID INT NOT NULL, P DBCLOB(1M) CCSID ${DBCS_CCSID}, B BLOB(1M))`
  );
  // **純 DBCS には直接の変換が無い**（ジョブの 5035 → 300 は `-332/57017`）。
  // 1200 を経由すれば通る（`20260801-pure-dbcs-dbclob`）
  await executeStatement(
    conn,
    `INSERT INTO ${TABLE} VALUES (1, ` +
      `CAST(CAST('${SEED_G}' AS DBCLOB(1M) CCSID 1200) AS DBCLOB(1M) CCSID ${DBCS_CCSID}), ` +
      `CAST(X'${SEED_B_HEX}' AS BLOB(1M)))`
  );
  // 倍々に伸ばす。**同じ CCSID どうしの連結は変換が要らない**ので 300 のまま伸びる
  for (let i = 0; i < 16; i++) {
    await executeStatement(conn, `UPDATE ${TABLE} SET P = P || P, B = B || B WHERE ID = 1`);
    const m = await query(conn, `SELECT OCTET_LENGTH(P) AS PB, OCTET_LENGTH(B) AS BB FROM ${TABLE}`);
    if (Number(m.rows[0].PB) >= TARGET_BYTES && Number(m.rows[0].BB) >= TARGET_BYTES) break;
  }
  const sz = (
    await query(conn, `SELECT OCTET_LENGTH(P) AS PB, LENGTH(P) AS PC, OCTET_LENGTH(B) AS BB FROM ${TABLE}`)
  ).rows[0];
  const pBytes = Number(sz.PB);
  const bBytes = Number(sz.BB);
  log(`フィクスチャ: ${TABLE}`);
  log(`  P (DBCLOB CCSID ${DBCS_CCSID}): ${pBytes} バイト / ${sz.PC} 文字（バイト = 文字 × 2）`);
  log(`  B (BLOB)                : ${bBytes} バイト\n`);
  check(pBytes > 65_536, `純 DBCS を 64KB 超で作れる（${pBytes} バイト）`);
  check(bBytes > 65_536, `BLOB を 64KB 超で作れる（${bBytes} バイト）`);

  // ---- 1. 純 DBCS の分割受信 ----
  log(`\n### 1. DBCLOB(CCSID ${DBCS_CCSID}) を上限 ${TARGET_BYTES} バイトで取る（分割 2 周）`);
  {
    const cell = (await query(conn, `SELECT P FROM ${TABLE} WHERE ID = 1`, { lob: { maxBytes: TARGET_BYTES } }))
      .rows[0].P;
    const v = cell?.value;
    const chars = typeof v === "string" ? v.length : 0;
    log(`  取れた: ${chars} 文字 = ${chars * 2} バイト / unavailable=${cell?.unavailable ?? "(なし)"}`);
    const cont = contiguousStr(v, SEED_G);
    check(cont === true, `**先頭から連続している（中抜けが無い）**${cont === true ? "" : ` — ${cont.why ?? `${cont.at} 文字目で食い違う`}`}`);
    check(chars * 2 === TARGET_BYTES, `上限ちょうど（${chars * 2}）`);
    check(cell?.byteLength === pBytes, `全体長はバイトで申告（${cell?.byteLength} / 実際 ${pBytes}）`);
    check(cell?.unavailable === "too-large", "打ち切りの印が立つ");
  }

  // ---- 2. BLOB の分割受信 ----
  log(`\n### 2. BLOB を上限 ${TARGET_BYTES} バイトで取る（分割 4 周）`);
  {
    const cell = (await query(conn, `SELECT B FROM ${TABLE} WHERE ID = 1`, { lob: { maxBytes: TARGET_BYTES } }))
      .rows[0].B;
    const v = cell?.value;
    check(v instanceof Uint8Array, `**バイト列のまま返る（文字列に化けない）** — ${typeof v === "string" ? "文字列で来た" : "バイト列"}`);
    log(`  取れた: ${v?.length ?? 0} バイト / unavailable=${cell?.unavailable ?? "(なし)"}`);
    log(`  先頭16: ${v instanceof Uint8Array ? hex(v) : "(なし)"}`);
    const cont = contiguousBytes(v, SEED_B);
    check(cont === true, `**先頭から連続している**${cont === true ? "" : ` — ${cont.why ?? `${cont.at} バイト目で食い違う`}`}`);
    check(v?.length === TARGET_BYTES, `上限ちょうど（${v?.length}）`);
    check(cell?.byteLength === bBytes, `全体長が一致（${cell?.byteLength}）`);
    check(cell?.unavailable === "too-large", "打ち切りの印が立つ");
  }

  // ---- 3. 打ち切り（1 セグメントに収まる）----
  log("\n### 3. 上限 40,000 バイトで打ち切る");
  {
    const row = (await query(conn, `SELECT P, B FROM ${TABLE} WHERE ID = 1`, { lob: { maxBytes: 40_000 } })).rows[0];
    const pChars = typeof row.P?.value === "string" ? row.P.value.length : 0;
    check(pChars * 2 === 40_000, `純 DBCS が上限ちょうど（${pChars * 2}）——**2 倍に膨らまない**`);
    check(contiguousStr(row.P?.value, SEED_G) === true, "純 DBCS が先頭から連続");
    check(row.B?.value?.length === 40_000, `BLOB が上限ちょうど（${row.B?.value?.length}）`);
    check(contiguousBytes(row.B?.value, SEED_B) === true, "BLOB が先頭から連続");
  }

  // ---- 4. 全部収まる場合 ----
  log("\n### 4. 小さい LOB は完全に取れる");
  {
    await executeStatement(
      conn,
      `INSERT INTO ${TABLE} VALUES (2, ` +
        `CAST(CAST('${SEED_G}' AS DBCLOB(1M) CCSID 1200) AS DBCLOB(1M) CCSID ${DBCS_CCSID}), ` +
        `CAST(X'${SEED_B_HEX}' AS BLOB(1M)))`
    );
    const row = (await query(conn, `SELECT P, B FROM ${TABLE} WHERE ID = 2`, { lob: { maxBytes: 64 * 1024 } }))
      .rows[0];
    check(row.P?.value === SEED_G, `純 DBCS が完全一致（${JSON.stringify(row.P?.value)}）`);
    check(
      row.B?.value instanceof Uint8Array && hex(row.B.value) === hex(SEED_B),
      `BLOB が完全一致（${row.B?.value instanceof Uint8Array ? hex(row.B.value) : row.B?.value}）`
    );
    check(row.P?.unavailable === undefined && row.B?.unavailable === undefined, "打ち切りの印が立たない");
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
