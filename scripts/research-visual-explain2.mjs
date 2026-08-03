/**
 * Visual Explain 調査 2: ダンプ表の中身（DB モニター形式）と、自分の文の特定。
 */
import { DbConnection, query, executeStatement, SqlError } from "@ts5250/hostserver";

const host = process.env["AS400_HOST"];
const user = process.env["AS400_USER"];
const password = process.env["AS400_PASSWORD"];
const tls = process.argv.includes("--tls");

const line = (s = "") => process.stdout.write(`${s}\n`);

async function step(label, fn) {
  line(`\n--- ${label}`);
  try {
    const r = await fn();
    if (r !== undefined) line(`OK: ${r}`);
    return true;
  } catch (e) {
    if (e instanceof SqlError) line(`NG: SQLCODE=${e.sqlCode} SQLSTATE=${e.sqlState}`);
    else line(`NG: ${String(e).slice(0, 300)}`);
    return false;
  }
}

async function main() {
  line(`host=${host} tls=${tls}`);
  const conn = await DbConnection.connect({ host, user, password, tls });
  try {
    // 目印になる一意な文を実行してプランキャッシュに載せる
    const marker = `VEPROBE_${Date.now()}`;
    await step(`目印つきの文を実行: ${marker}`, async () => {
      const r = await query(
        conn,
        `SELECT COUNT(*) AS N FROM QSYS2.SYSCOLUMNS WHERE TABLE_SCHEMA = 'QSYS2' AND '${marker}' = '${marker}'`
      );
      return JSON.stringify(r.rows[0]);
    });

    await step("プランキャッシュを丸ごとではなく TOPN でダンプ", async () => {
      const r = await executeStatement(conn, "CALL QSYS2.DUMP_PLAN_CACHE_TOPN('QTEMP', 'PCT', 50, 'RUNTIME')");
      return JSON.stringify(r);
    });

    await step("ダンプ表の列（DB モニター形式）", async () => {
      const r = await query(conn, "SELECT * FROM QTEMP.PCT FETCH FIRST 1 ROWS ONLY");
      line(`  列数: ${r.columns.length}`);
      line(`  列名: ${r.columns.map((c) => c.name).join(",").slice(0, 3000)}`);
    });

    await step("レコード種別(QQRID)の分布", async () => {
      const r = await query(
        conn,
        "SELECT CAST(QQRID AS VARCHAR(8)) CONCAT ' x' CONCAT CAST(COUNT(*) AS VARCHAR(8)) AS X FROM QTEMP.PCT GROUP BY QQRID ORDER BY QQRID"
      );
      for (const row of r.rows) line(`   ${row["X"]}`);
    });

    // 自分の文が載ったか（QQ1000 = 文テキスト）
    await step("目印つきの文がキャッシュにあるか（全体ダンプで確認）", async () => {
      await executeStatement(conn, "CALL QSYS2.DUMP_PLAN_CACHE('QTEMP', 'PCALL', -1)");
      const r = await query(
        conn,
        `SELECT COUNT(*) AS N FROM QTEMP.PCALL WHERE QQ1000 LIKE '%${marker}%'`
      );
      return JSON.stringify(r.rows[0]);
    });

    await step("その文の識別子まわり", async () => {
      const r = await query(
        conn,
        `SELECT CAST(QQRID AS VARCHAR(8)) CONCAT ' | plan=' CONCAT COALESCE(CAST(QQPLANID AS VARCHAR(24)),'-') CONCAT ' | qro=' CONCAT COALESCE(QVQROHASH,'-') CONCAT ' | job=' CONCAT COALESCE(QQJOB,'-') AS X FROM QTEMP.PCALL WHERE QQ1000 LIKE '%${marker}%' FETCH FIRST 10 ROWS ONLY`
      );
      for (const row of r.rows) line(`   ${row["X"]}`);
    });
  } finally {
    conn.close();
  }
}

main().catch((e) => {
  line(`FATAL: ${String(e)}`);
  process.exit(1);
});
