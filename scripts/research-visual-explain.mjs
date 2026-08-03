/**
 * Visual Explain 調査: プランキャッシュ系プロシージャが本アプリの SQL 経路で使えるか。
 * 1 接続を保ったまま順に流す（QTEMP をまたぐため）。
 */
import { DbConnection, query, executeStatement, SqlError } from "@ts5250/hostserver";

const host = process.env["AS400_HOST"];
const user = process.env["AS400_USER"];
const password = process.env["AS400_PASSWORD"];
const tls = process.argv.includes("--tls");

function line(s = "") {
  process.stdout.write(`${s}\n`);
}

async function step(label, fn) {
  line(`\n--- ${label}`);
  try {
    const r = await fn();
    if (r !== undefined) line(`OK: ${r}`);
    else line("OK");
    return true;
  } catch (e) {
    if (e instanceof SqlError) line(`NG: SQLCODE=${e.sqlCode} SQLSTATE=${e.sqlState} ${e.message}`);
    else line(`NG: ${String(e)}`);
    return false;
  }
}

function show(r, max = 8) {
  const cols = r.columns.map((c) => `${c.name || "(noname)"}:${c.typeName}`).join(", ");
  line(`  列(${r.columns.length}): ${cols.slice(0, 400)}`);
  line(`  行数: ${r.rows.length}`);
  for (const row of r.rows.slice(0, max)) {
    line(`   ${JSON.stringify(row).slice(0, 300)}`);
  }
}

async function main() {
  line(`host=${host} tls=${tls}`);
  const conn = await DbConnection.connect({ host, user, password, tls });
  try {
    // 0) 同一接続で QTEMP が持続するか（前提の確認）
    await step("QTEMP 持続確認: CREATE + INSERT + SELECT", async () => {
      await executeStatement(conn, "CREATE TABLE QTEMP.PROBE0 (A INT)");
      await executeStatement(conn, "INSERT INTO QTEMP.PROBE0 VALUES (42)");
      const r = await query(conn, "SELECT A FROM QTEMP.PROBE0");
      return `rows=${r.rows.length} ${JSON.stringify(r.rows[0])}`;
    });

    // 1) 計画を 1 つ作る（プランキャッシュに載せる）
    await step("計画を作る: SELECT COUNT(*) FROM QSYS2.SYSTABLES", async () => {
      const r = await query(conn, "SELECT COUNT(*) AS N FROM QSYS2.SYSTABLES WHERE TABLE_SCHEMA = 'QSYS2'");
      return JSON.stringify(r.rows[0]);
    });

    // 2) 自ジョブ名（あとで絞り込みに使えるか）
    await step("自ジョブ", async () => {
      const r = await query(conn, "SELECT CAST(QSYS2.JOB_NAME AS VARCHAR(40)) AS J FROM SYSIBM.SYSDUMMY1");
      return JSON.stringify(r.rows[0]);
    });

    // 3) DUMP_PLAN_CACHE_PROPERTIES（引数 2 つ・軽い）
    await step("CALL QSYS2.DUMP_PLAN_CACHE_PROPERTIES('QTEMP','PCP')", async () => {
      const r = await executeStatement(conn, "CALL QSYS2.DUMP_PLAN_CACHE_PROPERTIES('QTEMP', 'PCP')");
      return JSON.stringify(r);
    });
    await step("SELECT * FROM QTEMP.PCP", async () => {
      const r = await query(conn, "SELECT * FROM QTEMP.PCP");
      show(r, 3);
    });

    // 4) DUMP_PLAN_CACHE_TOPN: CATEGORY の正しい値を探る
    for (const cat of ["RUNTIME", "TOTAL_TIME", "AVERAGE_RUNTIME", "*RUNTIME"]) {
      const ok = await step(`CALL QSYS2.DUMP_PLAN_CACHE_TOPN('QTEMP','PCT10',10,'${cat}')`, async () => {
        const r = await executeStatement(conn, `CALL QSYS2.DUMP_PLAN_CACHE_TOPN('QTEMP', 'PCT10', 10, '${cat}')`);
        return JSON.stringify(r);
      });
      if (ok) break;
    }
    await step("QTEMP.PCT10 の列数と行数", async () => {
      const r = await query(conn, "SELECT COUNT(*) AS N FROM QTEMP.PCT10");
      return JSON.stringify(r.rows[0]);
    });
    await step("QTEMP.PCT10 の列名（先頭 40）", async () => {
      const r = await query(
        conn,
        "SELECT CAST(LISTAGG(COLUMN_NAME, ',') WITHIN GROUP (ORDER BY ORDINAL_POSITION) AS VARCHAR(2000)) AS C FROM QSYS2.SYSCOLUMNS WHERE TABLE_SCHEMA = 'QTEMP' AND TABLE_NAME = 'PCT10'"
      );
      line(`  ${String(r.rows[0]?.["C"] ?? "").slice(0, 1500)}`);
    });

    // 5) 結果セットを返すプロシージャが扱えるか（ここが分かれ目）
    await step("CALL QSYS2.LIST_EXPLAINABLE_DETAILED(...) を executeStatement で", async () => {
      const r = await executeStatement(
        conn,
        "CALL QSYS2.LIST_EXPLAINABLE_DETAILED('QTEMP', 'PCT10', 0, NULL, NULL, " +
          "NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL, " +
          "10, 10, NULL)"
      );
      return JSON.stringify(r);
    });
    await step("同じものを query() で（結果セットを取れるか）", async () => {
      const r = await query(
        conn,
        "CALL QSYS2.LIST_EXPLAINABLE_DETAILED('QTEMP', 'PCT10', 0, NULL, NULL, " +
          "NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL, " +
          "10, 10, NULL)"
      );
      show(r, 3);
    });

    // 6) 索引助言
    await step("QSYS2.SYSIXADV の件数と主要列", async () => {
      const r = await query(
        conn,
        "SELECT CAST(LISTAGG(COLUMN_NAME, ',') WITHIN GROUP (ORDER BY ORDINAL_POSITION) AS VARCHAR(2000)) AS C FROM QSYS2.SYSCOLUMNS WHERE TABLE_SCHEMA = 'QSYS2' AND TABLE_NAME = 'SYSIXADV'"
      );
      line(`  ${String(r.rows[0]?.["C"] ?? "").slice(0, 1200)}`);
      const n = await query(conn, "SELECT COUNT(*) AS N FROM QSYS2.SYSIXADV");
      return JSON.stringify(n.rows[0]);
    });
  } finally {
    conn.close();
  }
}

main().catch((e) => {
  line(`FATAL: ${String(e)}`);
  process.exit(1);
});
