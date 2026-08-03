/**
 * Visual Explain 調査 5: explain only の実現手段を探す。
 *  - QSYS2.PROCESS_DETAILED_MONITOR の MONITOR_OPTION に何が通るか（誤り時のメッセージを見る）
 *  - open だけで最適化記録が出るか（prepare では出ないことは調査4で確定済み）
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
    if (e instanceof SqlError) line(`NG: SQLCODE=${e.sqlCode} SQLSTATE=${e.sqlState} :: ${e.message.slice(0, 220)}`);
    else line(`NG: ${String(e).slice(0, 220)}`);
    return false;
  }
}

async function main() {
  line(`host=${host} tls=${tls}`);
  const conn = await DbConnection.connect({ host, user, password, tls });
  const target = "SELECT COUNT(*) FROM QSYS2.SYSCOLUMNS WHERE TABLE_SCHEMA = ''QSYS2''";
  try {
    for (const opt of ["EXPLAIN", "*EXPLAIN", "explain", "EXPLAIN_STATEMENT", "VISUAL_EXPLAIN", "?", ""]) {
      await step(`PROCESS_DETAILED_MONITOR('${opt}', ...)`, () =>
        executeStatement(
          conn,
          `CALL QSYS2.PROCESS_DETAILED_MONITOR('${opt}', 0, '${target}', '', '', 'QTEMP', 'VEX', 'QTEMP', 'VEMON')`
        )
      );
    }

    // 参考: SET_MONITOR_OPTION の引数（MONITOR_OPTION の語彙のヒントになりうる）
    await step("SET_MONITOR_OPTION の引数", async () => {
      const r = await query(
        conn,
        "SELECT CAST(p.SPECIFIC_NAME CONCAT ' #' CONCAT CAST(p.ORDINAL_POSITION AS CHAR(2)) CONCAT ' ' CONCAT COALESCE(p.PARAMETER_NAME,'?') CONCAT ' ' CONCAT p.PARAMETER_MODE CONCAT ' ' CONCAT p.DATA_TYPE AS VARCHAR(120)) AS X FROM QSYS2.SYSPARMS p JOIN QSYS2.SYSROUTINES r ON r.SPECIFIC_SCHEMA = p.SPECIFIC_SCHEMA AND r.SPECIFIC_NAME = p.SPECIFIC_NAME WHERE r.ROUTINE_SCHEMA = 'QSYS2' AND r.ROUTINE_NAME IN ('SET_MONITOR_OPTION','IMPORT_PC_EVENT_MONITOR') ORDER BY 1"
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
