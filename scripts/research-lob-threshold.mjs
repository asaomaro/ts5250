// LOB フィールドしきい値（CP 0x3822）を実機で確かめる。
//
// 原典はまとめ取りの要求を持たず、往復を減らすのは**しきい値**だけ
// （`20260801-lob-batch-retrieval-research`）。しきい値以下の LOB は行データに載って返る。
// **その「載り方」がこちらの復号（型コードで判定して 4 バイトのロケーターを読む）と
// 両立するか**は実機でしか分からないので、ここで測る。
//
// 実行:
//   node --env-file=.env --env-file=.env.verify scripts/research-lob-threshold.mjs            # 既定 AS400（実機）
//   HOSTPRE=PUB400 AS400_LIB=QGPL node --env-file=.env --env-file=.env.verify scripts/research-lob-threshold.mjs
//
// **往復が支配的な相手ほどしきい値が効く**ので、LAN（実機）だけでなく
// インターネット越し（pub400）でも測れるようにしてある。
//
// 表は `<AS400_LIB>/LOBTHR` を作り直す（冪等）。読み取りだけでは測れないので作る。
// ⚠ **pub400 は公開の共有機**。使うライブラリは QGPL に限り、最後に必ず落とす。
import { DbConnection, query, executeStatement } from "@ts5250/hostserver";

const PRE = process.env.HOSTPRE ?? "AS400";
const host = process.env[`${PRE}_HOST`];
const user = process.env[`${PRE}_USER`];
const password = process.env[`${PRE}_PASSWORD`];
if (!host || !user || !password) {
  process.stderr.write(`${PRE}_HOST / ${PRE}_USER / ${PRE}_PASSWORD を環境変数で渡してください\n`);
  process.exit(2);
}

const LIB = process.env.AS400_LIB ?? "TESTLIB";
const TABLE = `${LIB}.LOBTHR`;
const log = (s) => process.stdout.write(s + "\n");

/** 接続を開き、往復数と受信バイト数を数える */
async function open(lobFieldThreshold) {
  const conn = await DbConnection.connect({ host, user, password, ...(lobFieldThreshold ? { lobFieldThreshold } : {}) });
  const stat = { requests: 0, bytes: 0 };
  // request を包んで数える。**内部の往復も漏らさず数える**ため connect の後に掛ける
  const orig = conn.request.bind(conn);
  conn.request = async (o) => {
    stat.requests++;
    const r = await orig(o);
    // 応答本体の総バイト数（パラメータの値の合計。ヘッダは含まない）
    for (const p of r.params ?? []) {
      stat.bytes += p.value?.length ?? 0;
      // **行データらしい塊の先頭を控える**。インライン LOB の並び（長さ接頭辞の形）は
      // ここを見ないと分からない
      if ((p.value?.length ?? 0) > 100) stat.sample = { cp: p.cp, len: p.value.length, head: p.value.slice(0, 96) };
    }
    return r;
  };
  return { conn, stat };
}

async function setup() {
  const { conn } = await open(0);
  try {
    try { await executeStatement(conn, `DROP TABLE ${TABLE}`); } catch { /* 無ければ良い */ }
    // `G` は **DBCLOB**。長さの接頭辞が「バイト」か「文字」かは全角でしか判別できない
    await executeStatement(
      conn,
      `CREATE TABLE ${TABLE} (ID INT NOT NULL, SMALLC CLOB(1K), BIGC CLOB(200K), B BLOB(1K), G DBCLOB(1K) CCSID 1200)`
    );
    // 小さい CLOB（しきい値以下になる想定）と、大きい CLOB（超える想定）
    // **`REPEAT` の中間結果は VARCHAR** なので 32,739 文字で溢れる（-802/22001）。
    // 大きい方は先に CLOB へ鋳造してから繰り返す
    // 全角 3 文字（バイトなら 6、文字なら 3 で届く）
    await executeStatement(conn, `INSERT INTO ${TABLE} VALUES (1, REPEAT('a', 100), REPEAT(CAST('b' AS CLOB(200K)), 100000), BLOB(X'0102030405'), CAST('日本語' AS DBCLOB(1K) CCSID 1200))`);
    await executeStatement(conn, `INSERT INTO ${TABLE} VALUES (2, REPEAT('c', 500), REPEAT(CAST('d' AS CLOB(200K)), 150000), BLOB(X'FFEE'), CAST('全角混在ab' AS DBCLOB(1K) CCSID 1200))`);
    log(`フィクスチャ作成: ${TABLE}（2 行）`);
  } finally {
    conn.close();
  }
}

/**
 * 1 つのしきい値で SELECT し、列メタと行の中身・往復・バイト数を出す。
 *
 * **復号が落ちても止めない**。「落ちること」自体が測りたい結果なので、
 * 列メタだけでも先に出す（`query` は列を確定してから行を読む）。
 */
async function measure(threshold, sql, lobMaxBytes) {
  const { conn, stat } = await open(threshold);
  const t0 = Date.now();
  try {
    let r;
    try {
      r = await query(conn, sql, lobMaxBytes ? { lob: { maxBytes: lobMaxBytes } } : {});
    } catch (e) {
      log(`\n### しきい値 ${threshold}${lobMaxBytes ? ` / LOB 取得 ${lobMaxBytes}B` : ""} — ${sql}`);
      log(`  往復 ${stat.requests} / 受信 ${stat.bytes} バイト / ${Date.now() - t0}ms`);
      log(`  ⚠ 復号で失敗: ${e?.code ?? ""} ${e?.message ?? String(e)}`);
      if (stat.sample) {
        const hex = [...stat.sample.head].map((b) => b.toString(16).padStart(2, "0")).join(" ");
        log(`  行データらしき塊 cp=0x${stat.sample.cp.toString(16)} len=${stat.sample.len} 先頭 96 バイト:`);
        log(`    ${hex}`);
      }
      return { failed: String(e?.message ?? e), requests: stat.requests, bytes: stat.bytes };
    }
    const ms = Date.now() - t0;
    log(`\n### しきい値 ${threshold}${lobMaxBytes ? ` / LOB 取得 ${lobMaxBytes}B` : ""} — ${sql}`);
    log(`  往復 ${stat.requests} / 受信 ${stat.bytes} バイト / ${ms}ms`);
    log(`  列:`);
    for (const c of r.columns) {
      log(`    ${c.name.padEnd(8)} type=${c.type} ${c.typeName.padEnd(14)} len=${String(c.length).padStart(7)} ccsid=${c.ccsid} lobMaxSize=${c.lobMaxSize ?? "-"}`);
    }
    log(`  行:`);
    for (const row of r.rows) {
      const cells = Object.entries(row).map(([k, v]) => {
        if (v && typeof v === "object" && v.kind === "lob") {
          const body = typeof v.value === "string" ? `"${v.value.slice(0, 12)}"(${v.value.length}文字)`
            : v.value ? `<bytes ${v.value.length}>` : "なし";
          return `${k}={lob locator=${v.locator} maxSize=${v.maxSize} unavailable=${v.unavailable ?? "-"} value=${body}}`;
        }
        return `${k}=${typeof v === "string" ? `"${v.slice(0, 12)}"` : String(v)}`;
      });
      log(`    ${cells.join(" ")}`);
    }
    return { requests: stat.requests, bytes: stat.bytes, ms, columns: r.columns, rows: r.rows };
  } finally {
    conn.close();
  }
}

await setup();

// 小さい CLOB だけを引く（しきい値の効きを見る）
const smallSql = `SELECT ID, SMALLC FROM ${TABLE} ORDER BY ID`;
await measure(0, smallSql);
// **現状の痛みの基準線**——しきい値 0 のまま中身を取ると、セルの数だけ往復が増える
await measure(0, smallSql, 64 * 1024);
await measure(64 * 1024, smallSql);

// 大きい CLOB（100KB / 150KB）を混ぜる——しきい値 64KB を跨ぐ
const bigSql = `SELECT ID, SMALLC, BIGC, B FROM ${TABLE} ORDER BY ID`;
await measure(0, bigSql);
await measure(0, bigSql, 64 * 1024);
await measure(64 * 1024, bigSql);

// **しきい値を超える LOB だけ**を引く。ロケーターのまま来るなら
// 「超えたものだけがロケーター」という原典のコメントが実機で裏づく
const overSql = `SELECT ID, BIGC FROM ${TABLE} ORDER BY ID`;
await measure(64 * 1024, overSql);

// **DBCLOB（全角）**。長さの接頭辞がバイトか文字かはここでしか判別できない
const dbcsSql = `SELECT ID, G FROM ${TABLE} ORDER BY ID`;
await measure(0, dbcsSql, 64 * 1024);
await measure(64 * 1024, dbcsSql);

log("\n完了");
