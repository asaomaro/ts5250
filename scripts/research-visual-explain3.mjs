/**
 * Visual Explain 調査 3:
 *  (1) ダンプ表の列メタ（CCSID 65535 がどれか）
 *  (2) 自ジョブ DB モニター経路（特権不要で自分の文の計画を採れるか）
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
    else line(`NG: ${String(e).slice(0, 250)}`);
    return false;
  }
}

async function main() {
  line(`host=${host} tls=${tls}`);
  const conn = await DbConnection.connect({ host, user, password, tls });
  try {
    // (1) 列メタだけ取る（行を返さないので decode しない）
    await step("TOPN ダンプ", async () => {
      await executeStatement(conn, "CALL QSYS2.DUMP_PLAN_CACHE_TOPN('QTEMP', 'PCT', 20, 'RUNTIME')");
    });
    await step("ダンプ表の列メタ（WHERE 1=0）", async () => {
      const r = await query(conn, "SELECT * FROM QTEMP.PCT WHERE 1 = 0");
      line(`  列数: ${r.columns.length}`);
      const bin = r.columns.filter((c) => c.ccsid === 65535);
      line(`  CCSID 65535 の列 (${bin.length}): ${bin.map((c) => `${c.name}:${c.typeName}`).join(",")}`);
      line(`  全列: ${r.columns.map((c) => c.name).join(",")}`);
    });

    // (2) 自ジョブ DB モニター
    const marker = `VEMON_${Date.now()}`;
    await step("QCMDEXC で自ジョブに STRDBMON", async () => {
      const r = await executeStatement(
        conn,
        "CALL QSYS2.QCMDEXC('STRDBMON OUTFILE(QTEMP/VEMON) JOB(*) TYPE(*DETAIL)')"
      );
      return JSON.stringify(r);
    });
    await step(`監視下で文を実行: ${marker}`, async () => {
      const r = await query(
        conn,
        `SELECT COUNT(*) AS N FROM QSYS2.SYSCOLUMNS WHERE TABLE_SCHEMA = 'QSYS2' AND '${marker}' = '${marker}'`
      );
      return JSON.stringify(r.rows[0]);
    });
    await step("ENDDBMON", async () => {
      await executeStatement(conn, "CALL QSYS2.QCMDEXC('ENDDBMON JOB(*)')");
    });
    await step("モニター表のレコード種別分布", async () => {
      const r = await query(
        conn,
        "SELECT CAST(QQRID AS VARCHAR(8)) CONCAT ' x' CONCAT CAST(COUNT(*) AS VARCHAR(8)) AS X FROM QTEMP.VEMON GROUP BY QQRID ORDER BY QQRID"
      );
      for (const row of r.rows) line(`   ${row["X"]}`);
      return `種別 ${r.rows.length}`;
    });
    await step("目印つきの文がモニターに載ったか", async () => {
      const r = await query(
        conn,
        `SELECT COUNT(*) AS N FROM QTEMP.VEMON WHERE QQ1000 LIKE '%${marker}%'`
      );
      return JSON.stringify(r.rows[0]);
    });
    await step("その文の 3000 レコード（文サマリ）", async () => {
      const r = await query(
        conn,
        `SELECT CAST(QQRID AS VARCHAR(6)) CONCAT ' | ' CONCAT COALESCE(CAST(QQI6 AS VARCHAR(20)),'-') CONCAT ' | ' CONCAT COALESCE(SUBSTR(QQ1000,1,80),'-') AS X FROM QTEMP.VEMON WHERE QQ1000 LIKE '%${marker}%' FETCH FIRST 5 ROWS ONLY`
      );
      for (const row of r.rows) line(`   ${row["X"]}`);
    });
    await step("その文に紐づく全レコード種別（計画ノード）", async () => {
      const r = await query(
        conn,
        `SELECT CAST(QQRID AS VARCHAR(6)) CONCAT ' x' CONCAT CAST(COUNT(*) AS VARCHAR(6)) AS X FROM QTEMP.VEMON WHERE QQUCNT IN (SELECT QQUCNT FROM QTEMP.VEMON WHERE QQ1000 LIKE '%${marker}%') GROUP BY QQRID ORDER BY QQRID`
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
